import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import './index.css'

// Import Google Fonts
const link = document.createElement('link');
link.href = 'https://fonts.googleapis.com/css2?family=Outfit:wght@400;600;800&display=swap';
link.rel = 'stylesheet';
document.head.appendChild(link);

// Explicitly preload and register Unifont into document.fonts
if (typeof document !== 'undefined' && document.fonts) {
  document.fonts.load('16px "Unifont"');
}

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }
  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }
  componentDidCatch(error, info) {
    console.error('[ErrorBoundary] Caught render error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          height: '100vh', background: '#0a0f1a', color: '#e2e8f0', fontFamily: 'Outfit, sans-serif', gap: 16
        }}>
          <div style={{ fontSize: 40 }}>⚠️</div>
          <h2 style={{ fontSize: 20, fontWeight: 800, margin: 0 }}>Something went wrong</h2>
          <p style={{ color: '#94a3b8', fontSize: 13, margin: 0 }}>
            {this.state.error?.message || 'An unexpected error occurred'}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: 8, padding: '10px 24px', background: '#10b981', color: '#fff',
              border: 'none', borderRadius: 8, fontWeight: 700, cursor: 'pointer', fontSize: 14
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>,
)

