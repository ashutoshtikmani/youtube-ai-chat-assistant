import { GoogleGenerativeAI } from '@google/generative-ai';
import { CSV_TOOL_DECLARATIONS } from './csvTools';

const COMPUTE_STATS_JSON_DECLARATION = {
  name: 'compute_stats_json',
  description:
    'Compute mean, median, standard deviation, min, max, and count for a numeric field in the loaded YouTube channel JSON.',
  parameters: {
    type: 'object',
    properties: {
      field: {
        type: 'string',
        description: 'Numeric field name such as view_count, like_count, or comment_count',
      },
    },
    required: ['field'],
  },
};

const PLOT_METRIC_VS_TIME_DECLARATION = {
  name: 'plot_metric_vs_time',
  description:
    'Plot a line chart of a numeric metric (view_count, like_count, or comment_count) over time using release_date from the loaded YouTube channel JSON. Use when the user asks to visualize how a metric changes over time, or to see trends.',
  parameters: {
    type: 'object',
    properties: {
      metric: {
        type: 'string',
        description: 'Numeric metric field: view_count, like_count, or comment_count',
      },
    },
    required: ['metric'],
  },
};

const PLAY_VIDEO_DECLARATION = {
  name: 'play_video',
  description:
    'Display a clickable video card (thumbnail + title) from the loaded YouTube channel JSON. Supports matching by title, ordinal position (first, second, third), or most viewed.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description:
          'User request, e.g. "play the asbestos video", "play the first video", "play the most viewed video"',
      },
    },
    required: ['query'],
  },
};

const GENERATE_IMAGE_DECLARATION = {
  name: 'generateImage',
  description:
    'Generate an image from a text prompt using Gemini image generation. Optionally provide an anchor/reference image (base64) for image editing or style transfer.',
  parameters: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'Text description of the image to generate or editing instructions',
      },
      anchorImage: {
        type: 'string',
        description: 'Optional base64-encoded image string to use as reference/input for editing',
      },
    },
    required: ['prompt'],
  },
};

const genAI = new GoogleGenerativeAI(process.env.REACT_APP_GEMINI_API_KEY || '');

const MODEL = 'gemini-2.5-flash';

const SEARCH_TOOL = { googleSearch: {} };
const CODE_EXEC_TOOL = { codeExecution: {} };

export const CODE_KEYWORDS = /\b(plot|chart|graph|analyz|statistic|regression|correlat|histogram|visualiz|calculat|compute|run code|write code|execute|pandas|numpy|matplotlib|csv|data)\b/i;

let cachedPrompt = null;

async function loadSystemPrompt() {
  if (cachedPrompt) return cachedPrompt;
  try {
    const res = await fetch('/prompt_chat.txt');
    cachedPrompt = res.ok ? (await res.text()).trim() : '';
  } catch {
    cachedPrompt = '';
  }
  return cachedPrompt;
}

const IMAGE_MODEL = 'models/gemini-2.5-flash-image';

export async function generateImageFromGemini(prompt, anchorImage = null) {
  console.log("🔥 IMAGE FUNCTION CALLED");
  try {
    const imgModel = genAI.getGenerativeModel({ model: IMAGE_MODEL });
    const parts = [{ text: prompt || 'Generate an image' }];
    if (anchorImage && typeof anchorImage === "string") {

      // If data URL, extract raw base64
      let base64Data = anchorImage;

      if (anchorImage.startsWith("data:")) {
        base64Data = anchorImage.split(",")[1];
      }

      const mimeMatch = anchorImage.match(/^data:(.*?);base64,/);
      const mimeType = mimeMatch ? mimeMatch[1] : "image/png";

      parts.push({
        inlineData: {
          mimeType,
          data: base64Data
        }
      });
    }

    console.log('[generateImageFromGemini] IMAGE_MODEL:', IMAGE_MODEL);
    console.log('[generateImageFromGemini] prompt length:', (prompt || '').length);
    console.log('[generateImageFromGemini] anchorImage exists:', !!anchorImage);
    console.log('[generateImageFromGemini] anchorImage first 40 chars:', anchorImage ? String(anchorImage).slice(0, 40) : '(none)');
    console.log('[generateImageFromGemini] parts being sent:', JSON.stringify(parts.map((p) => (p.text ? { text: p.text } : { inlineData: { mimeType: p.inlineData?.mimeType, dataLength: p.inlineData?.data?.length } }))));

    const result = await imgModel.generateContent({
      contents: [
        {
          role: "user",
          parts: parts,
        },
      ],
    });

    console.log('[generateImageFromGemini] result.response:', result.response);
    const candidates = result.response?.candidates;
    console.log('[generateImageFromGemini] candidates:', candidates);
    const firstContentParts = candidates?.[0]?.content?.parts;
    console.log('[generateImageFromGemini] candidates[0].content.parts:', firstContentParts);

    if (!candidates?.length) {
      return {
        error: 'No image was generated. The prompt may have been blocked.',
        debug: { hasCandidates: false, partsKeys: null },
      };
    }

    const allParts = firstContentParts || [];
    const imagePart = allParts.find((p) => p.inlineData);
    const partsKeys = allParts.map((p) => Object.keys(p || {}));

    if (!imagePart?.inlineData?.data) {
      return {
        error: 'No image data in response.',
        debug: { hasCandidates: true, partsKeys },
      };
    }

    return {
      _toolType: 'generateImage',
      imageBase64: imagePart.inlineData.data,
      mimeType: imagePart.inlineData.mimeType || 'image/png',
    };
  } catch (err) {
    return {
      error: 'Image generation failed',
      debug: {
        message: err.message,
        name: err.name,
        stack: err.stack?.slice(0, 300),
      },
    };
  }
}

// Yields:
//   { type: 'text', text }           — streaming text chunks
//   { type: 'fullResponse', parts }  — when code was executed; replaces streamed text
//   { type: 'grounding', data }      — Google Search metadata
//
// fullResponse parts: { type: 'text'|'code'|'result'|'image', ... }
//
// useCodeExecution: pass true to use codeExecution tool (CSV/analysis),
//                   false (default) to use googleSearch tool.
// Note: Gemini does not support both tools simultaneously.
export const streamChat = async function* (history, newMessage, imageParts = [], useCodeExecution = false, user = null, executeFn = null) {
  let systemInstruction = await loadSystemPrompt();
  systemInstruction += `\n\nYou are speaking to ${user?.firstName || user?.username} ${user?.lastName || ''}. Address them by their first name in your first response.`;
  const model = genAI.getGenerativeModel({ model: MODEL });

  const baseHistory = history.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({
    history: chatHistory,
    tools: [
      {
        functionDeclarations: [
          ...CSV_TOOL_DECLARATIONS,
          COMPUTE_STATS_JSON_DECLARATION,
          PLOT_METRIC_VS_TIME_DECLARATION,
          PLAY_VIDEO_DECLARATION,
          GENERATE_IMAGE_DECLARATION,
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: "AUTO",
      },
    },
  });

  const parts = [
    { text: newMessage },
    ...imageParts.map((img) => ({
      inlineData: { mimeType: img.mimeType || 'image/png', data: img.data },
    })),
  ].filter((p) => p.text !== undefined || p.inlineData !== undefined);

  const result = await chat.sendMessageStream(parts);

  let pendingFunctionCall = null;

  for await (const chunk of result.stream) {
    console.log("STREAM CHUNK:", chunk);

    const chunkParts = chunk.candidates?.[0]?.content?.parts || [];

    for (const part of chunkParts) {

      // TEXT
      if (part.text) {
        yield { type: "text", text: part.text };
      }

      // FUNCTION CALL
      if (part.functionCall) {
        console.log("🔧 FUNCTION CALL PART:", part.functionCall);

        pendingFunctionCall = {
          name: part.functionCall.name,
          args: part.functionCall.args,
        };
      }
    }
  }

  // Execute tool after stream ends
  if (pendingFunctionCall && executeFn) {
    console.log("🔥 EXECUTING TOOL:", pendingFunctionCall);

    const parsedArgs =
      typeof pendingFunctionCall.args === "string"
        ? JSON.parse(pendingFunctionCall.args)
        : pendingFunctionCall.args;

    const toolResult = await executeFn(
      pendingFunctionCall.name,
      parsedArgs
    );

    yield { type: "tool", data: toolResult };
  }

  // After stream: inspect all response parts
  const response = await result.response;
  const allParts = response.candidates?.[0]?.content?.parts || [];

  const hasCodeExecution = allParts.some(
    (p) =>
      p.executableCode ||
      p.codeExecutionResult ||
      (p.inlineData && p.inlineData.mimeType?.startsWith('image/'))
  );

  if (hasCodeExecution) {
    // Build ordered structured parts to replace the streamed text
    const structuredParts = allParts
      .map((p) => {
        if (p.text) return { type: 'text', text: p.text };
        if (p.executableCode)
          return {
            type: 'code',
            language: p.executableCode.language || 'PYTHON',
            code: p.executableCode.code,
          };
        if (p.codeExecutionResult)
          return {
            type: 'result',
            outcome: p.codeExecutionResult.outcome,
            output: p.codeExecutionResult.output,
          };
        if (p.inlineData)
          return { type: 'image', mimeType: p.inlineData.mimeType, data: p.inlineData.data };
        return null;
      })
      .filter(Boolean);

    yield { type: 'fullResponse', parts: structuredParts };
  }

  // Grounding metadata (search sources)
  const grounding = response.candidates?.[0]?.groundingMetadata;
  if (grounding) {
    console.log('[Search grounding]', grounding);
    yield { type: 'grounding', data: grounding };
  }
};

// ── Function-calling chat for CSV tools ───────────────────────────────────────
// Gemini picks a tool + args → executeFn runs it client-side (free) → Gemini
// receives the result and returns a natural-language answer.
//
// executeFn(toolName, args) → plain JS object with the result
// Returns the final text response from the model.

export const chatWithCsvTools = async (history, newMessage, csvHeaders, executeFn, user = null) => {
  let systemInstruction = await loadSystemPrompt();
  systemInstruction += `\n\nYou are speaking to ${user?.firstName || user?.username} ${user?.lastName || ''}. Address them by their first name in your first response.`;
  const model = genAI.getGenerativeModel({ model: MODEL });

  const baseHistory = history.map((m) => ({
    role: m.role === 'user' ? 'user' : 'model',
    parts: [{ text: m.content || '' }],
  }));

  const chatHistory = systemInstruction
    ? [
        {
          role: 'user',
          parts: [{ text: `Follow these instructions in every response:\n\n${systemInstruction}` }],
        },
        { role: 'model', parts: [{ text: "Got it! I'll follow those instructions." }] },
        ...baseHistory,
      ]
    : baseHistory;

  const chat = model.startChat({
    history: chatHistory,
    tools: [
      {
        functionDeclarations: [
          ...CSV_TOOL_DECLARATIONS,
          COMPUTE_STATS_JSON_DECLARATION,
          PLOT_METRIC_VS_TIME_DECLARATION,
          PLAY_VIDEO_DECLARATION,
          GENERATE_IMAGE_DECLARATION,
        ],
      },
    ],
    toolConfig: {
      functionCallingConfig: {
        mode: "AUTO",
      },
    },
  });

  // Include column names so the model can match user intent to exact column names
  const msgWithContext = csvHeaders?.length
    ? `[CSV columns: ${csvHeaders.join(', ')}]\n\n${newMessage}`
    : newMessage;

  let response = (await chat.sendMessage(msgWithContext)).response;

  // Accumulate chart payloads and a log of every tool call made
  const charts = [];
  const toolCalls = [];

  // Function-calling loop (Gemini may chain multiple tool calls)
  for (let round = 0; round < 5; round++) {
    const parts = response.candidates?.[0]?.content?.parts || [];
    const funcCall = parts.find((p) => p.functionCall);
    if (!funcCall) break;

    const { name, args } = funcCall.functionCall;
    console.log('[CSV Tool]', name, args);
    const toolResult = await Promise.resolve(executeFn(name, args));
    console.log('[CSV Tool result]', toolResult);

    // Log the call for persistence
    toolCalls.push({ name, args, result: toolResult });

    // Capture chart payloads so the UI can render them
    if (toolResult?._chartType) {
      charts.push(toolResult);
    }

    response = (
      await chat.sendMessage([
        { functionResponse: { name, response: { result: toolResult } } },
      ])
    ).response;
  }

  return { text: response.text(), charts, toolCalls };
};
