import { useState } from 'react';
import Auth from './components/Auth';
import Chat from './components/Chat';
import YouTubeDownload from './components/YouTubeDownload';
import './App.css';

function App() {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('chatapp_user');
    if (stored) return JSON.parse(stored);
    return null;
  });

  const [activeTab, setActiveTab] = useState('chat');

  const handleLogin = (user) => {
    localStorage.setItem('chatapp_user', JSON.stringify(user));
    setUser(user);
  };

  const handleLogout = () => {
    localStorage.removeItem('chatapp_user');
    setUser(null);
  };

  if (user) {
    return (
      <div className="app-container">
        <div className="top-nav">
          <div className="nav-left">
            <button
              className={activeTab === 'chat' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setActiveTab('chat')}
            >
              Chat
            </button>
            <button
              className={activeTab === 'youtube' ? 'nav-btn active' : 'nav-btn'}
              onClick={() => setActiveTab('youtube')}
            >
              YouTube Channel Download
            </button>
          </div>

          <div className="nav-right">
            <span className="nav-username">
              {user?.firstName || user?.username}
            </span>
            <button className="logout-btn" onClick={handleLogout}>
              Logout
            </button>
          </div>
        </div>

        <div className="content-area">
          {activeTab === 'chat' && (
            <Chat user={user} onLogout={handleLogout} />
          )}

          {activeTab === 'youtube' && (
            <YouTubeDownload />
          )}
        </div>
      </div>
    );
  }
  return <Auth onLogin={handleLogin} />;
}

export default App;
