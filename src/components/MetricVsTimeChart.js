import { useState, useRef } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { toPng } from 'html-to-image';

const formatMetric = (m) => {
  const map = { view_count: 'Views', like_count: 'Likes', comment_count: 'Comments' };
  return map[m] || m;
};

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div
      style={{
        background: 'rgba(15, 15, 35, 0.92)',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: 10,
        padding: '0.65rem 0.9rem',
        fontSize: '0.82rem',
        fontFamily: 'Inter, sans-serif',
        color: '#e2e8f0',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}
    >
      <p style={{ margin: '0 0 0.4rem', fontWeight: 700, color: '#fff' }}>{label}</p>
      {payload.map((p) => (
        <p key={p.dataKey} style={{ margin: '0.15rem 0', color: p.stroke }}>
          {p.name}: <strong>{Number(p.value).toLocaleString()}</strong>
        </p>
      ))}
    </div>
  );
}

export default function MetricVsTimeChart({ data, metric }) {
  const [modalOpen, setModalOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const chartRef = useRef(null);

  if (!Array.isArray(data) || data.length === 0) return null;

  const chartData = data.map((d) => ({ date: d.date, value: d.value, [metric]: d.value }));

  const handleDownload = async () => {
    if (!chartRef.current) return;
    setDownloading(true);
    try {
      const dataUrl = await toPng(chartRef.current, { backgroundColor: '#0f0f0f', pixelRatio: 2 });
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `metric_vs_time_${metric}.png`;
      a.click();
    } catch (err) {
      console.error('Download failed:', err);
    } finally {
      setDownloading(false);
    }
  };

  const chartContent = (
    <div style={{ background: '#0f0f0f', padding: 16, borderRadius: 12 }}>
      <div ref={chartRef}>
        <p style={{ margin: '0 0 12px', fontSize: 14, color: 'rgba(255,255,255,0.8)' }}>
          {formatMetric(metric)} over time
        </p>
        <ResponsiveContainer width="100%" height={280}>
        <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 48 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 11, fontFamily: 'Inter,sans-serif' }}
            axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
            tickLine={false}
            angle={-30}
            textAnchor="end"
          />
          <YAxis
            tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11, fontFamily: 'Inter,sans-serif' }}
            axisLine={false}
            tickLine={false}
            width={55}
            tickFormatter={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v)}
          />
          <Tooltip content={<CustomTooltip />} />
          <Line
            type="monotone"
            dataKey="value"
            name={formatMetric(metric)}
            stroke="#818cf8"
            strokeWidth={2}
            dot={{ fill: '#818cf8', r: 3 }}
            activeDot={{ r: 5 }}
          />
        </LineChart>
      </ResponsiveContainer>
      </div>
    </div>
  );

  return (
    <div className="metric-vs-time-chart-wrap">
      <div
        className="metric-vs-time-chart-inner"
        onClick={() => setModalOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setModalOpen(true)}
        style={{ cursor: 'pointer' }}
      >
        {chartContent}
        <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            className="metric-chart-download-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleDownload();
            }}
            disabled={downloading}
          >
            {downloading ? 'Exporting...' : 'Download PNG'}
          </button>
          <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>Click to enlarge</span>
        </div>
      </div>

      {modalOpen && (
        <div
          className="metric-chart-modal-overlay"
          onClick={() => setModalOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setModalOpen(false)}
          role="button"
          tabIndex={0}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.8)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 9999,
            padding: 24,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#1a1a1a',
              borderRadius: 16,
              padding: 24,
              maxWidth: '90vw',
              maxHeight: '90vh',
              overflow: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ margin: 0, color: '#fff' }}>{formatMetric(metric)} over time</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                style={{
                  background: 'transparent',
                  border: '1px solid rgba(255,255,255,0.3)',
                  color: '#fff',
                  padding: '6px 12px',
                  borderRadius: 8,
                  cursor: 'pointer',
                }}
              >
                Close
              </button>
            </div>
            <div style={{ minWidth: 500, minHeight: 400 }}>
              <ResponsiveContainer width="100%" height={400}>
                <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 48 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.07)" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tick={{ fill: 'rgba(255,255,255,0.6)', fontSize: 11 }}
                    axisLine={{ stroke: 'rgba(255,255,255,0.12)' }}
                    tickLine={false}
                    angle={-30}
                    textAnchor="end"
                  />
                  <YAxis
                    tick={{ fill: 'rgba(255,255,255,0.5)', fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                    width={55}
                    tickFormatter={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : v)}
                  />
                  <Tooltip content={<CustomTooltip />} />
                  <Line
                    type="monotone"
                    dataKey="value"
                    name={formatMetric(metric)}
                    stroke="#818cf8"
                    strokeWidth={2}
                    dot={{ fill: '#818cf8', r: 4 }}
                    activeDot={{ r: 6 }}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
