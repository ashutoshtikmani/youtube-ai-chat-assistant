import { useState } from 'react';

const YouTubeDownload = () => {
  const [channelUrl, setChannelUrl] = useState('');
  const [maxVideos, setMaxVideos] = useState(10);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);

  const handleDownload = async () => {
    if (!channelUrl) return;

    try {
      setLoading(true);
      setProgress(20);

      const res = await fetch('/api/youtube/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelUrl, maxVideos }),
      });

      setProgress(60);

      const data = await res.json();
      setProgress(90);

      // Create downloadable JSON file
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: 'application/json',
      });
      const url = window.URL.createObjectURL(blob);

      const a = document.createElement('a');
      a.href = url;
      a.download = 'channel_data.json';
      document.body.appendChild(a);
      a.click();
      a.remove();

      setProgress(100);
    } catch (err) {
      console.error(err);
    } finally {
      setTimeout(() => {
        setLoading(false);
        setProgress(0);
      }, 800);
    }
  };

  return (
    <div className="yt-wrapper">
      <div className="yt-card">
        <h2 className="yt-title">YouTube Channel Download</h2>

        <div className="yt-field">
          <label>Channel URL</label>
          <input
            type="text"
            value={channelUrl}
            onChange={(e) => setChannelUrl(e.target.value)}
            placeholder="https://www.youtube.com/@veritasium"
          />
        </div>

        <div className="yt-field">
          <label>Max Videos (1–100)</label>
          <input
            type="number"
            value={maxVideos}
            min={1}
            max={100}
            onChange={(e) => setMaxVideos(Number(e.target.value))}
          />
        </div>

        <button className="yt-button" onClick={handleDownload} disabled={loading}>
          Download Channel Data
        </button>

        {loading && (
          <div style={{ marginTop: '20px' }}>
            <div style={{
              height: '6px',
              background: '#333',
              borderRadius: '4px',
              overflow: 'hidden'
            }}>
              <div style={{
                width: `${progress}%`,
                height: '100%',
                background: 'linear-gradient(90deg, #2563eb, #4f46e5)',
                transition: '0.3s ease'
              }} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default YouTubeDownload;
