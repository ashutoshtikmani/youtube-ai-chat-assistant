import { useState } from 'react';

export default function ImageResult({ imageBase64, mimeType = 'image/png' }) {
  const [modalOpen, setModalOpen] = useState(false);

  if (!imageBase64) return null;

  const dataUrl = `data:${mimeType};base64,${imageBase64}`;

  const handleDownload = () => {
    const a = document.createElement('a');
    a.href = dataUrl;
    a.download = `generated-image-${Date.now()}.png`;
    a.click();
  };

  return (
    <div className="image-result-wrap">
      <div
        className="image-result-inner"
        onClick={() => setModalOpen(true)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && setModalOpen(true)}
      >
        <img src={dataUrl} alt="Generated" className="image-result-img generated-image" />
        <div className="image-result-actions">
          <button
            type="button"
            className="image-result-download-btn"
            onClick={(e) => {
              e.stopPropagation();
              handleDownload();
            }}
          >
            Download PNG
          </button>
          <span className="image-result-hint">Click to enlarge</span>
        </div>
      </div>

      {modalOpen && (
        <div
          className="image-result-modal-overlay modal-overlay"
          onClick={() => setModalOpen(false)}
          onKeyDown={(e) => e.key === 'Escape' && setModalOpen(false)}
          role="button"
          tabIndex={0}
        >
          <div
            className="image-result-modal-content"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="image-result-modal-header">
              <h3 className="image-result-modal-title">Generated image</h3>
              <button
                type="button"
                className="image-result-modal-close"
                onClick={() => setModalOpen(false)}
              >
                Close
              </button>
            </div>
            <img src={dataUrl} alt="Generated fullscreen" className="image-result-modal-img modal-image" />
          </div>
        </div>
      )}
    </div>
  );
}
