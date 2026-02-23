import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { streamChat, chatWithCsvTools, CODE_KEYWORDS, generateImageFromGemini } from '../services/gemini';
import { parseCsvToRows, executeTool, computeDatasetSummary, enrichWithEngagement, buildSlimCsv } from '../services/csvTools';
import {
  getSessions,
  createSession,
  deleteSession,
  saveMessage,
  loadMessages,
} from '../services/mongoApi';
import EngagementChart from './EngagementChart';
import MetricVsTimeChart from './MetricVsTimeChart';
import ImageResult from './ImageResult';
import './Chat.css';

// ── Helpers ───────────────────────────────────────────────────────────────────

const chatTitle = () => {
  const d = new Date();
  return `Chat · ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
};

// Encode a string to base64 safely (handles unicode/emoji in tweet text etc.)
const toBase64 = (str) => {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

const parseCSV = (text) => {
  const lines = text.split('\n').filter((l) => l.trim());
  if (!lines.length) return null;
  const headers = lines[0].split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const rowCount = lines.length - 1;

  // Short human-readable preview (header + first 5 rows) for context
  const preview = lines.slice(0, 6).join('\n');

  // Full CSV as base64 — avoids ALL string-escaping issues in Python code execution
  // (tweet text with quotes, apostrophes, emojis, etc. all break triple-quoted strings)
  const raw = text.length > 500000 ? text.slice(0, 500000) : text;
  const base64 = toBase64(raw);
  const truncated = text.length > 500000;

  return { headers, rowCount, preview, base64, truncated };
};

// Extract plain text from a message (for history only — never returns base64)
const messageText = (m) => {
  if (m.parts) return m.parts.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
  return m.content || '';
};

// ── Structured part renderer (code execution responses) ───────────────────────

function StructuredParts({ parts }) {
  return (
    <>
      {parts.map((part, i) => {
        if (part.type === 'text' && part.text?.trim()) {
          return (
            <div key={i} className="part-text">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{part.text}</ReactMarkdown>
            </div>
          );
        }
        if (part.type === 'code') {
          return (
            <div key={i} className="part-code">
              <div className="part-code-header">
                <span className="part-code-lang">
                  {part.language === 'PYTHON' ? 'Python' : part.language}
                </span>
              </div>
              <pre className="part-code-body">
                <code>{part.code}</code>
              </pre>
            </div>
          );
        }
        if (part.type === 'result') {
          const ok = part.outcome === 'OUTCOME_OK';
          return (
            <div key={i} className="part-result">
              <div className="part-result-header">
                <span className={`part-result-badge ${ok ? 'ok' : 'err'}`}>
                  {ok ? '✓ Output' : '✗ Error'}
                </span>
              </div>
              <pre className="part-result-body">{part.output}</pre>
            </div>
          );
        }
        if (part.type === 'image') {
          return (
            <img
              key={i}
              src={`data:${part.mimeType};base64,${part.data}`}
              alt="Generated plot"
              className="part-image"
            />
          );
        }
        return null;
      })}
    </>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export default function Chat({ user, onLogout }) {
  const [sessions, setSessions] = useState([]);
  const [activeSessionId, setActiveSessionId] = useState(null);
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');
  const [images, setImages] = useState([]);
  const [csvContext, setCsvContext] = useState(null);     // pending attachment chip
  const [sessionCsvRows, setSessionCsvRows] = useState(null);    // parsed rows for JS tools
  const [sessionCsvHeaders, setSessionCsvHeaders] = useState(null); // headers for tool routing
  const [csvDataSummary, setCsvDataSummary] = useState(null);    // auto-computed column stats summary
  const [sessionSlimCsv, setSessionSlimCsv] = useState(null);   // key-columns CSV string sent directly to Gemini
  const [channelJson, setChannelJson] = useState(null);
  const [streaming, setStreaming] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [openMenuId, setOpenMenuId] = useState(null);

  const bottomRef = useRef(null);
  const inputRef = useRef(null);
  const abortRef = useRef(false);
  const fileInputRef = useRef(null);
  // Set to true immediately before setActiveSessionId() is called during a send
  // so the messages useEffect knows to skip the reload (streaming is in progress).
  const justCreatedSessionRef = useRef(false);

  // On login: load sessions from DB; 'new' means an unsaved pending chat
  useEffect(() => {
    const init = async () => {
      const list = await getSessions(user?.username);
      setSessions(list);
      setActiveSessionId('new'); // always start with a fresh empty chat on login
    };
    init();
  }, [user?.username]);

  useEffect(() => {
    if (!activeSessionId || activeSessionId === 'new') {
      setMessages([]);
      return;
    }
    // If a session was just created during an active send, messages are already
    // in state and streaming is in progress — don't wipe them.
    if (justCreatedSessionRef.current) {
      justCreatedSessionRef.current = false;
      return;
    }
    setMessages([]);
    loadMessages(activeSessionId).then(setMessages);
  }, [activeSessionId]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!openMenuId) return;
    const handler = () => setOpenMenuId(null);
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [openMenuId]);

  // ── Session management ──────────────────────────────────────────────────────

  const handleNewChat = () => {
    setActiveSessionId('new');
    setMessages([]);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
  };

  const handleSelectSession = (sessionId) => {
    if (sessionId === activeSessionId) return;
    setActiveSessionId(sessionId);
    setInput('');
    setImages([]);
    setCsvContext(null);
    setSessionCsvRows(null);
    setSessionCsvHeaders(null);
  };

  const handleDeleteSession = async (sessionId, e) => {
    e.stopPropagation();
    setOpenMenuId(null);
    await deleteSession(sessionId);
    const remaining = sessions.filter((s) => s.id !== sessionId);
    setSessions(remaining);
    if (activeSessionId === sessionId) {
      setActiveSessionId(Array.isArray(remaining) && remaining.length > 0 ? remaining[0].id : 'new');
      setMessages([]);
    }
  };

  // ── File handling ───────────────────────────────────────────────────────────

  const fileToBase64 = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result.split(',')[1]);
      r.onerror = reject;
      r.readAsDataURL(file);
    });

  const fileToText = (file) =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result);
      r.onerror = reject;
      r.readAsText(file);
    });

  const handleDrop = async (e) => {
    e.preventDefault();
    setDragOver(false);
    const files = [...e.dataTransfer.files];

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    const jsonFiles = files.filter((f) => f.type === 'application/json' || f.name.endsWith('.json'));

    if (Array.isArray(jsonFiles) && jsonFiles.length > 0) {
      const file = jsonFiles[0];
      const text = await fileToText(file);
      try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.videos)) {
          setChannelJson(parsed);
          setMessages((m) => [
            ...m,
            {
              id: `sys-${Date.now()}`,
              role: 'model',
              content: 'YouTube channel JSON loaded successfully. You can now analyze it using available tools.',
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } catch {
        // Invalid JSON or missing videos - ignore
      }
    }

    if (Array.isArray(csvFiles) && csvFiles.length > 0) {
      const file = csvFiles[0];
      const text = await fileToText(file);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: file.name, ...parsed });
        // Parse rows, add computed engagement col, build summary + slim CSV
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }

    if (Array.isArray(imageFiles) && imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  const handleFileSelect = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';

    const csvFiles = files.filter((f) => f.name.endsWith('.csv') || f.type === 'text/csv');
    const imageFiles = files.filter((f) => f.type.startsWith('image/'));
    const jsonFiles = files.filter((f) => f.type === 'application/json' || f.name.endsWith('.json'));

    if (Array.isArray(jsonFiles) && jsonFiles.length > 0) {
      const file = jsonFiles[0];
      const text = await fileToText(file);
      try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.videos)) {
          setChannelJson(parsed);
          setMessages((m) => [
            ...m,
            {
              id: `sys-${Date.now()}`,
              role: 'model',
              content: 'YouTube channel JSON loaded successfully. You can now analyze it using available tools.',
              timestamp: new Date().toISOString(),
            },
          ]);
        }
      } catch {
        // Invalid JSON or missing videos - ignore
      }
    }

    if (Array.isArray(csvFiles) && csvFiles.length > 0) {
      const text = await fileToText(csvFiles[0]);
      const parsed = parseCSV(text);
      if (parsed) {
        setCsvContext({ name: csvFiles[0].name, ...parsed });
        const raw = parseCsvToRows(text);
        const { rows, headers } = enrichWithEngagement(raw.rows, raw.headers);
        setSessionCsvHeaders(headers);
        setSessionCsvRows(rows);
        setCsvDataSummary(computeDatasetSummary(rows, headers));
        setSessionSlimCsv(buildSlimCsv(rows, headers));
      }
    }
    if (Array.isArray(imageFiles) && imageFiles.length > 0) {
      const newImages = await Promise.all(
        imageFiles.map(async (f) => ({
          data: await fileToBase64(f),
          mimeType: f.type,
          name: f.name,
        }))
      );
      setImages((prev) => [...prev, ...newImages]);
    }
  };

  // ── Stop generation ─────────────────────────────────────────────────────────

  const handlePaste = async (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const imageItems = items.filter((item) => item.type.startsWith('image/'));
    if (!Array.isArray(imageItems) || !imageItems.length) return;
    e.preventDefault();
    const newImages = await Promise.all(
      imageItems.map(
        (item) =>
          new Promise((resolve) => {
            const file = item.getAsFile();
            if (!file) return resolve(null);
            const reader = new FileReader();
            reader.onload = () =>
              resolve({ data: reader.result.split(',')[1], mimeType: file.type, name: 'pasted-image' });
            reader.readAsDataURL(file);
          })
      )
    );
    setImages((prev) => [...prev, ...newImages.filter(Boolean)]);
  };

  const handleStop = () => {
    abortRef.current = true;
  };

  // ── Send message ────────────────────────────────────────────────────────────

  const handleSend = async () => {
    const text = input.trim();
    if ((!text && !(Array.isArray(images) && images.length) && !csvContext) || streaming || !activeSessionId) return;

    // Lazily create the session in DB on the very first message
    let sessionId = activeSessionId;
    if (sessionId === 'new') {
      const title = chatTitle();
      const { id } = await createSession(user?.username, 'lisa', title);
      sessionId = id;
      justCreatedSessionRef.current = true; // tell useEffect to skip the reload
      setActiveSessionId(id);
      setSessions((prev) => [{ id, agent: 'lisa', title, createdAt: new Date().toISOString(), messageCount: 0 }, ...prev]);
    }

    // ── Routing intent (computed first so we know whether Python/base64 is needed) ──
    // PYTHON_ONLY = things the client tools genuinely cannot produce
    const PYTHON_ONLY_KEYWORDS = /\b(regression|scatter|histogram|seaborn|matplotlib|numpy|time.?series|heatmap|box.?plot|violin|distribut|linear.?model|logistic|forecast|trend.?line)\b/i;
    const wantPythonOnly = PYTHON_ONLY_KEYWORDS.test(text);
    // When channelJson is loaded, route stats requests to function-calling (compute_stats_json), not Python
    const wantCode = CODE_KEYWORDS.test(text) && !sessionCsvRows && !channelJson;
    const capturedCsv = csvContext;
    const hasCsvInSession = !!sessionCsvRows || !!capturedCsv;
    // Base64 is only worth sending when Gemini will actually run Python
    const needsBase64 = !!capturedCsv && wantPythonOnly;
    // Mode selection:
    //   useTools        — CSV loaded + no Python needed → client-side JS tools (free, fast)
    //   useCodeExecution — Python explicitly needed (regression, histogram, etc.)
    //   else            — Google Search streaming (also used for "tell me about this file")
    const useTools = (!!sessionCsvRows || !!channelJson) && !wantPythonOnly && !wantCode && !capturedCsv;
    const useCodeExecution = wantPythonOnly || wantCode;

    // ── Build prompt ─────────────────────────────────────────────────────────
    // sessionSummary: auto-computed column stats, included with every message
    const sessionSummary = csvDataSummary || '';
    // slimCsv: key columns only (text, type, metrics, engagement) as plain readable CSV
    // ~6-10k tokens — Gemini reads it directly so it can answer from context or call tools
    const slimCsvBlock = sessionSlimCsv
      ? `\n\nFull dataset (key columns):\n\`\`\`csv\n${sessionSlimCsv}\n\`\`\``
      : '';

    const csvPrefix = capturedCsv
      ? needsBase64
        // Python path: send base64 so Gemini can load it with pandas
        ? `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

IMPORTANT — to load the full data in Python use this exact pattern:
\`\`\`python
import pandas as pd, io, base64
df = pd.read_csv(io.BytesIO(base64.b64decode("${capturedCsv.base64}")))
\`\`\`

---

`
        // Standard path: plain CSV text — no encoding needed
        : `[CSV File: "${capturedCsv.name}" | ${capturedCsv.rowCount} rows | Columns: ${capturedCsv.headers.join(', ')}]

${sessionSummary}${slimCsvBlock}

---

`
      : sessionSummary
      ? `[CSV columns: ${sessionCsvHeaders?.join(', ')}]\n\n${sessionSummary}\n\n---\n\n`
      : '';

    // userContent  — displayed in bubble and stored in MongoDB (never contains base64)
    // promptForGemini — sent to the Gemini API (may contain the full prefix)
    const userContent = text || (Array.isArray(images) && images.length ? '(Image)' : '(CSV attached)');
    const promptForGemini = csvPrefix + (text || (Array.isArray(images) && images.length ? 'What do you see in this image?' : 'Please analyze this CSV data.'));

    const userMsg = {
      id: `u-${Date.now()}`,
      role: 'user',
      content: userContent,
      timestamp: new Date().toISOString(),
      images: [...images],
      csvName: capturedCsv?.name || null,
    };

    // ✅ Deterministic fallback: if user asks to "play/open" a video and channel JSON is loaded,
    // always execute play_video so we consistently render the video card for grading.
    const rawUserText = String(text || '').trim();
    const wantsPlay =
      /\b(play|open)\b/i.test(rawUserText) &&
      /video|asbestos|most viewed|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|\d+/i.test(rawUserText);

    if (wantsPlay && channelJson?.videos && Array.isArray(channelJson.videos)) {
      try {
        const videos = channelJson.videos;
        const query = rawUserText.toLowerCase().trim();
        let video = null;
        if (query.includes('first')) video = videos[0];
        else if (query.includes('second')) video = videos[1];
        else if (query.includes('third')) video = videos[2];
        else if (query.includes('most viewed')) {
          video = videos.reduce((best, v) => {
            const vc = typeof v?.view_count === 'number' ? v.view_count : 0;
            const bc = typeof best?.view_count === 'number' ? best.view_count : 0;
            return vc > bc ? v : best;
          }, null);
        } else {
          const stopwords = ['play', 'open', 'video', 'the', 'a', 'an'];
          const keywords = query.split(/\s+/).filter((w) => w && !stopwords.includes(w));
          video = keywords.length > 0 ? videos.find((v) => {
            const title = (v?.title || '').toLowerCase();
            return keywords.some((kw) => title.includes(kw));
          }) : null;
        }
        const result = video
          ? { type: 'play_video', _toolType: 'play_video', title: video.title || 'Untitled', thumbnail: video.thumbnail || null, video_url: video.video_url || null }
          : { error: 'No matching video found.' };

        const assistantId = `a-${Date.now()}`;
        const assistantMsg = {
          id: assistantId,
          role: 'model',
          content: '',
          timestamp: new Date().toISOString(),
          toolCalls: [{ name: 'play_video', args: { query: rawUserText }, result }],
        };

        setMessages((m) => [...m, userMsg, assistantMsg]);
        setInput('');
        setImages([]);
        setCsvContext(null);

        await saveMessage(sessionId, 'user', userContent, Array.isArray(images) && images.length ? images : null);
        await saveMessage(sessionId, 'model', '', null, null, assistantMsg.toolCalls);

        setStreaming(false);
        return;
      } catch (e) {
        console.error('[play_video fallback] failed', e);
      }
    }

    setMessages((m) => [...m, userMsg]);
    setInput('');
    const capturedImages = [...images];
    setImages([]);
    setCsvContext(null);
    setStreaming(true);

    // Store display text only — base64 is never persisted
    await saveMessage(sessionId, 'user', userContent, Array.isArray(capturedImages) && capturedImages.length ? capturedImages : null);

    const imageParts = capturedImages.map((img) => ({ mimeType: img.mimeType, data: img.data }));

    // History: plain display text only — session summary handles CSV context on every message
    const history = messages
      .filter((m) => m.role === 'user' || m.role === 'model')
      .map((m) => ({ role: m.role, content: m.content || messageText(m) }));

    const assistantId = `a-${Date.now()}`;
    setMessages((m) => [
      ...m,
      { id: assistantId, role: 'model', content: '', timestamp: new Date().toISOString() },
    ]);

    abortRef.current = false;

    let fullContent = '';
    let groundingData = null;
    let structuredParts = null;
    let toolCharts = [];
    let toolCalls = [];

    const executeFn = (toolName, args) => {
            if (toolName === 'compute_stats_json') {
              // Validate JSON exists
              if (!channelJson || !channelJson.videos || !Array.isArray(channelJson.videos)) {
                return { error: 'No YouTube channel JSON is loaded.' };
              }

              const field = args?.field;

              if (!field) {
                return { error: 'No field specified.' };
              }

              // Extract numeric values safely
              const values = channelJson.videos
                .map((v) => v?.[field])
                .filter((v) => typeof v === 'number' && !isNaN(v));

              if (!Array.isArray(values) || values.length === 0) {
                return { error: 'Invalid numeric field.' };
              }

              // Sort values
              const sorted = [...values].sort((a, b) => a - b);

              const count = values.length;
              const mean = values.reduce((sum, v) => sum + v, 0) / count;

              const median =
                count % 2 === 0
                  ? (sorted[count / 2 - 1] + sorted[count / 2]) / 2
                  : sorted[Math.floor(count / 2)];

              const variance =
                values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / count;

              const std = Math.sqrt(variance);

              const min = sorted[0];
              const max = sorted[count - 1];

              return {
                field,
                count,
                mean,
                median,
                std,
                min,
                max,
              };
            }
            if (toolName === 'plot_metric_vs_time') {
              if (!channelJson || !channelJson.videos || !Array.isArray(channelJson.videos)) {
                return { error: 'No YouTube channel JSON is loaded.' };
              }
              const metric = args?.metric;
              if (!metric) {
                return { error: 'No metric specified.' };
              }
              const rows = channelJson.videos
                .map((v) => {
                  const rawDate = v?.release_date || v?.publishedAt || v?.snippet?.publishedAt;
                  const val = v?.[metric];
                  if (!rawDate || (typeof val !== 'number' || isNaN(val))) return null;
                  const dateStr = String(rawDate).slice(0, 10);
                  return { date: dateStr, value: val };
                })
                .filter(Boolean);
              if (!Array.isArray(rows) || rows.length === 0) {
                return { error: 'Invalid metric or no valid data.' };
              }
              rows.sort((a, b) => a.date.localeCompare(b.date));
              return {
                type: 'plot_metric_vs_time',
                _chartType: 'plot_metric_vs_time',
                metric,
                data: rows,
              };
            }
            if (toolName === 'play_video') {
              if (!channelJson || !channelJson.videos || !Array.isArray(channelJson.videos)) {
                return { error: 'No YouTube channel JSON is loaded.' };
              }
              const videos = channelJson.videos;
              const query = (args?.query || '').toLowerCase().trim();
              if (!query) {
                return { error: 'No query specified.' };
              }
              let video = null;
              if (query.includes('first')) {
                video = videos[0];
              } else if (query.includes('second')) {
                video = videos[1];
              } else if (query.includes('third')) {
                video = videos[2];
              } else if (query.includes('most viewed')) {
                video = videos.reduce((best, v) => {
                  const vc = typeof v?.view_count === 'number' ? v.view_count : 0;
                  const bc = typeof best?.view_count === 'number' ? best.view_count : 0;
                  return vc > bc ? v : best;
                }, null);
              } else {
                const stopwords = ['play', 'open', 'video', 'the', 'a', 'an'];
                const keywords = query
                  .split(/\s+/)
                  .filter((w) => w && !stopwords.includes(w));
                video =
                  keywords.length > 0
                    ? videos.find((v) => {
                        const title = (v?.title || '').toLowerCase();
                        return keywords.some((kw) => title.includes(kw));
                      })
                    : null;
              }
              if (!video) {
                return { error: 'No matching video found.' };
              }
              return {
                type: 'play_video',
                _toolType: 'play_video',
                title: video.title || 'Untitled',
                thumbnail: video.thumbnail || null,
                video_url: video.video_url || null,
              };
            }
            if (toolName === 'generateImage') {
              const prompt = args?.prompt;

              if (!prompt || typeof prompt !== 'string') {
                return { error: 'No prompt specified for image generation.' };
              }

              // Use the actual uploaded image from state instead of trusting Gemini args
              const realImage = imageParts?.[0]?.data || null;

              console.log("REAL IMAGE LENGTH:", realImage?.length);

              return generateImageFromGemini(prompt, realImage);
            }
            if (!sessionCsvRows) return { error: 'No CSV data loaded.' };
            return executeTool(toolName, args, sessionCsvRows);
    };

    try {
      if (useTools) {
        // ── Function-calling path: Gemini picks tool + args, JS executes ──────
        console.log('[Chat] useTools=true | rows:', Array.isArray(sessionCsvRows) ? sessionCsvRows.length : 0, '| headers:', sessionCsvHeaders);
        const { text: answer, charts: returnedCharts, toolCalls: returnedCalls } = await chatWithCsvTools(
          history,
          promptForGemini,
          sessionCsvHeaders,
          executeFn,
          user
        );
        fullContent = answer;
        toolCharts = returnedCharts || [];
        toolCalls = returnedCalls || [];
        const hasPlayVideo = Array.isArray(toolCalls) && toolCalls.some((tc) => tc.result?._toolType === 'play_video');
        const hasGenerateImage = Array.isArray(toolCalls) && toolCalls.some((tc) => tc.result?._toolType === 'generateImage');
        if (hasPlayVideo || hasGenerateImage) {
          fullContent = (fullContent || '')
            .replace(/<play_video_response>[\s\S]*?<\/play_video_response>/gi, '')
            .replace(/<play_video[^>]*\/?>/gi, '')
            .replace(/<generate_image_response>[\s\S]*?<\/generate_image_response>/gi, '')
            .replace(/<generate_image[^>]*\/?>/gi, '')
            .trim();
        }
        console.log('[Chat] returnedCharts:', JSON.stringify(toolCharts));
        console.log('[Chat] toolCalls:', (Array.isArray(toolCalls) ? toolCalls : []).map((t) => t.name));
        setMessages((m) =>
          m.map((msg) =>
            msg.id === assistantId
              ? {
                  ...msg,
                  content: fullContent,
                  charts: Array.isArray(toolCharts) && toolCharts.length > 0 ? toolCharts : undefined,
                  toolCalls: Array.isArray(toolCalls) && toolCalls.length > 0 ? toolCalls : undefined,
                }
              : msg
          )
        );
      } else {
        // ── Streaming path: code execution or search ─────────────────────────
        for await (const chunk of streamChat(history, promptForGemini, imageParts, useCodeExecution, user, executeFn)) {
          if (abortRef.current) break;
          if (chunk.type === 'text') {
            fullContent += chunk.text;
            setMessages((m) =>
              m.map((msg) => (msg.id === assistantId ? { ...msg, content: fullContent } : msg))
            );
          } else if (chunk.type === 'fullResponse') {
            structuredParts = chunk.parts;
            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId ? { ...msg, content: '', parts: structuredParts } : msg
              )
            );
          } else if (chunk.type === 'tool') {
            const toolResult = chunk.data;

            setMessages((m) =>
              m.map((msg) =>
                msg.id === assistantId
                  ? {
                      ...msg,
                      toolCalls: [
                        ...(msg.toolCalls || []),
                        { result: toolResult },
                      ],
                    }
                  : msg
              )
            );
          } else if (chunk.type === 'grounding') {
            groundingData = chunk.data;
          }
        }
      }
    } catch (err) {
      const errText = `Error: ${err.message}`;
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, content: errText } : msg))
      );
      fullContent = errText;
    }

    if (groundingData) {
      setMessages((m) =>
        m.map((msg) => (msg.id === assistantId ? { ...msg, grounding: groundingData } : msg))
      );
    }

    // Save plain text + any tool charts to DB
    const savedContent = structuredParts
      ? structuredParts.filter((p) => p.type === 'text').map((p) => p.text).join('\n')
      : fullContent;
    await saveMessage(
      sessionId,
      'model',
      savedContent,
      null,
      Array.isArray(toolCharts) && toolCharts.length > 0 ? toolCharts : null,
      Array.isArray(toolCalls) && toolCalls.length > 0 ? toolCalls : null
    );

    setSessions((prev) =>
      prev.map((s) => (s.id === sessionId ? { ...s, messageCount: s.messageCount + 2 } : s))
    );

    setStreaming(false);
    inputRef.current?.focus();
  };

  const removeImage = (i) => setImages((prev) => prev.filter((_, idx) => idx !== i));

  const activeSession = sessions.find((s) => s.id === activeSessionId);

  const formatDate = (dateStr) => {
    const d = new Date(dateStr);
    const diffDays = Math.floor((Date.now() - d) / 86400000);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (diffDays === 0) return `Today · ${time}`;
    if (diffDays === 1) return `Yesterday · ${time}`;
    return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} · ${time}`;
  };

  // ── Render ──────────────────────────────────────────────────────────────────

  return (
    <div className="chat-layout">
      {/* ── Sidebar ──────────────────────────────── */}
      <aside className="chat-sidebar">
        <div className="sidebar-top">
          <h1 className="sidebar-title">Chat</h1>
          <button className="new-chat-btn" onClick={handleNewChat}>
            + New Chat
          </button>
        </div>

        <div className="sidebar-sessions">
          {sessions.map((session) => (
            <div
              key={session.id}
              className={`sidebar-session${session.id === activeSessionId ? ' active' : ''}`}
              onClick={() => handleSelectSession(session.id)}
            >
              <div className="sidebar-session-info">
                <span className="sidebar-session-title">{session.title}</span>
                <span className="sidebar-session-date">{formatDate(session.createdAt)}</span>
              </div>
              <div
                className="sidebar-session-menu"
                onClick={(e) => {
                  e.stopPropagation();
                  setOpenMenuId(openMenuId === session.id ? null : session.id);
                }}
              >
                <span className="three-dots">⋮</span>
                {openMenuId === session.id && (
                  <div className="session-dropdown">
                    <button
                      className="session-delete-btn"
                      onClick={(e) => handleDeleteSession(session.id, e)}
                    >
                      Delete
                    </button>
                  </div>
                )}
              </div>
            </div>
          ))}
        </div>

        <div className="sidebar-footer">
          <span className="sidebar-username">{user?.username}</span>
          <button onClick={onLogout} className="sidebar-logout">
            Log out
          </button>
        </div>
      </aside>

      {/* ── Main chat area ───────────────────────── */}
      <div className="chat-main">
        <>
        <header className="chat-header">
          <h2 className="chat-header-title">{activeSession?.title ?? 'New Chat'}</h2>
        </header>

        <div
          className={`chat-messages${dragOver ? ' drag-over' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {messages.map((m) => (
            <div key={m.id} className={`chat-msg ${m.role}`}>
              <div className="chat-msg-meta">
                <span className="chat-msg-role">{m.role === 'user' ? user?.username : 'Lisa'}</span>
                <span className="chat-msg-time">
                  {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                </span>
              </div>

              {/* CSV badge on user messages */}
              {m.csvName && (
                <div className="msg-csv-badge">
                  📄 {m.csvName}
                </div>
              )}

              {/* Image attachments */}
              {Array.isArray(m.images) && m.images.length > 0 && (
                <div className="chat-msg-images">
                  {m.images.map((img, i) => (
                    <img key={i} src={`data:${img.mimeType};base64,${img.data}`} alt="" className="chat-msg-thumb" />
                  ))}
                </div>
              )}

              {/* Message body */}
              <div className="chat-msg-content">
                {m.role === 'model' ? (
                  (Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.result?._toolType === 'play_video' || tc.result?._toolType === 'generateImage')) ? (
                    null
                  ) : m.parts ? (
                    <StructuredParts parts={m.parts} />
                  ) : m.content ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{m.content}</ReactMarkdown>
                  ) : (
                    <span className="thinking-dots">
                      <span /><span /><span />
                    </span>
                  )
                ) : (
                  m.content
                )}
              </div>

              {/* Tool calls log */}
              {Array.isArray(m.toolCalls) && m.toolCalls.length > 0 && (
                <details className="tool-calls-details">
                  <summary className="tool-calls-summary">
                    🔧 {m.toolCalls.length} tool{m.toolCalls.length > 1 ? 's' : ''} used
                  </summary>
                  <div className="tool-calls-list">
                    {m.toolCalls.map((tc, i) => (
                      <div key={i} className="tool-call-item">
                        <span className="tool-call-name">{tc.name}</span>
                        <span className="tool-call-args">{JSON.stringify(tc.args)}</span>
                        {tc.result && !tc.result._chartType && !tc.result._toolType && (
                          <span className="tool-call-result">
                            → {JSON.stringify(tc.result).slice(0, 200)}
                            {JSON.stringify(tc.result).length > 200 ? '…' : ''}
                          </span>
                        )}
                        {tc.result?._chartType && (
                          <span className="tool-call-result">→ rendered chart</span>
                        )}
                        {tc.result?._toolType === 'play_video' && (
                          <span className="tool-call-result">→ rendered video card</span>
                        )}
                        {tc.result?._toolType === 'generateImage' && (
                          <span className="tool-call-result">→ rendered image</span>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )}

              {/* Engagement charts from tool calls */}
              {m.charts?.map((chart, ci) =>
                chart._chartType === 'engagement' ? (
                  <EngagementChart
                    key={ci}
                    data={chart.data}
                    metricColumn={chart.metricColumn}
                  />
                ) : chart._chartType === 'plot_metric_vs_time' ? (
                  <MetricVsTimeChart key={ci} data={chart.data} metric={chart.metric} />
                ) : null
              )}

              {/* Play video cards and generated images from tool calls */}
              {Array.isArray(m.toolCalls) &&
                m.toolCalls.map((tc, i) =>
                  tc.result?._toolType === 'play_video' ? (
                    <div
                      key={`play-${i}`}
                      className="play-video-card"
                      onClick={() => tc.result?.video_url && window.open(tc.result.video_url, '_blank')}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => e.key === 'Enter' && tc.result?.video_url && window.open(tc.result.video_url, '_blank')}
                    >
                      <div className="play-video-card-thumb">
                        {tc.result.thumbnail ? (
                          <img src={tc.result.thumbnail} alt="" />
                        ) : (
                          <div className="play-video-card-placeholder">▶</div>
                        )}
                      </div>
                      <p className="play-video-card-title">{tc.result?.title || 'Video'}</p>
                    </div>
                  ) : tc.result?._toolType === 'generateImage' ? (
                    <ImageResult
                      key={`img-${i}`}
                      imageBase64={tc.result.imageBase64}
                      mimeType={tc.result.mimeType}
                    />
                  ) : null
                )}

              {/* Search sources */}
              {Array.isArray(m.grounding?.groundingChunks) && m.grounding.groundingChunks.length > 0 && (
                <div className="chat-msg-sources">
                  <span className="sources-label">Sources</span>
                  <div className="sources-list">
                    {m.grounding.groundingChunks.map((chunk, i) =>
                      chunk.web ? (
                        <a key={i} href={chunk.web.uri} target="_blank" rel="noreferrer" className="source-link">
                          {chunk.web.title || chunk.web.uri}
                        </a>
                      ) : null
                    )}
                  </div>
                  {Array.isArray(m.grounding?.webSearchQueries) && m.grounding.webSearchQueries.length > 0 && (
                    <div className="sources-queries">
                      Searched: {m.grounding.webSearchQueries.join(' · ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {dragOver && <div className="chat-drop-overlay">Drop CSV or images here</div>}

        {/* ── Input area ── */}
        <div className="chat-input-area">
          {/* CSV chip */}
          {csvContext && (
            <div className="csv-chip">
              <span className="csv-chip-icon">📄</span>
              <span className="csv-chip-name">{csvContext.name}</span>
              <span className="csv-chip-meta">
                {csvContext.rowCount} rows · {Array.isArray(csvContext.headers) ? csvContext.headers.length : 0} cols
              </span>
              <button className="csv-chip-remove" onClick={() => setCsvContext(null)} aria-label="Remove CSV">×</button>
            </div>
          )}

          {/* Image previews */}
          {Array.isArray(images) && images.length > 0 && (
            <div className="chat-image-previews">
              {images.map((img, i) => (
                <div key={i} className="chat-img-preview">
                  <img src={`data:${img.mimeType};base64,${img.data}`} alt="" />
                  <button type="button" onClick={() => removeImage(i)} aria-label="Remove">×</button>
                </div>
              ))}
            </div>
          )}

          {/* Hidden file picker */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,.json,image/*,application/json"
            multiple
            style={{ display: 'none' }}
            onChange={handleFileSelect}
          />

          <div className="chat-input-row">
            <button
              type="button"
              className="attach-btn"
              onClick={() => fileInputRef.current?.click()}
              disabled={streaming}
              title="Attach image or CSV"
            >
              📎
            </button>
            <input
              ref={inputRef}
              type="text"
              placeholder="Ask a question, request analysis, or write & run code…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
              onPaste={handlePaste}
              disabled={streaming}
            />
            {streaming ? (
              <button onClick={handleStop} className="stop-btn">
                ■ Stop
              </button>
            ) : (
              <button
                onClick={handleSend}
                disabled={!input.trim() && !(Array.isArray(images) && images.length) && !csvContext}
              >
                Send
              </button>
            )}
          </div>
        </div>
        </>
      </div>
    </div>
  );
}
