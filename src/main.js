import './style.css';
import { Header } from './components/Header.js';
import { ImageStudio } from './components/ImageStudio.js';
import { initExternalResults } from './lib/externalResults.js';
import { openDebugPanel, isDebugAvailable } from './components/DebugPanel.js';

// Native alert()/confirm()/prompt() leave the Electron window without keyboard focus on Windows
// (clicks work, typing does not, until the window is minimised and restored): give the focus back.
for (const name of ['alert', 'confirm', 'prompt']) {
  const native = window[name].bind(window);
  window[name] = (...args) => {
    const result = native(...args);
    setTimeout(() => window.localAI?.refocus?.(), 0);
    return result;
  };
}

// Errors on screen go to the debug log too (desktop app), and Ctrl+Shift+D opens it.
if (isDebugAvailable()) {
  window.addEventListener('error', (e) => window.localAI.debug.log('window', 'error', e.message, { file: e.filename, line: e.lineno }));
  window.addEventListener('unhandledrejection', (e) => window.localAI.debug.log('window', 'error', 'unhandled promise rejection', { reason: String(e.reason?.message || e.reason) }));
  window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'd') { e.preventDefault(); openDebugPanel(); }
  });
}

const app = document.querySelector('#app');
let contentArea;

// Keep all mounted page nodes so async generation survives tab switches
const mountedPages = {};

// Router — show/hide instead of destroy
function navigate(page) {
  if (!contentArea) return;

  // Hide all existing pages
  Object.values(mountedPages).forEach(node => { node.style.display = 'none'; });

  if (mountedPages[page]) {
    // Already mounted — just show it again
    mountedPages[page].style.display = '';
  } else {
    // First visit — create a wrapper and mount the studio into it
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'width:100%;height:100%;display:flex;flex-direction:column;';
    contentArea.appendChild(wrapper);
    mountedPages[page] = wrapper;

    if (page === 'image') {
      wrapper.appendChild(ImageStudio());
    } else if (page === 'video') {
      import('./components/VideoStudio.js').then(({ VideoStudio }) => {
        wrapper.appendChild(VideoStudio());
      });
    } else if (page === 'cinema') {
      import('./components/CinemaStudio.js').then(({ CinemaStudio }) => {
        wrapper.appendChild(CinemaStudio());
      });
    } else if (page === 'lipsync') {
      import('./components/LipSyncStudio.js').then(({ LipSyncStudio }) => {
        wrapper.appendChild(LipSyncStudio());
      });
    } else if (page === 'movie') {
      import('./components/MovieStudio.js').then(({ MovieStudio }) => {
        wrapper.appendChild(MovieStudio());
      });
    } else if (page === 'anime') {
      import('./components/AnimeStudio.js').then(({ AnimeStudio }) => {
        wrapper.appendChild(AnimeStudio());
      });
    } else if (page === 'workflows') {
      import('./components/WorkflowStudio.js').then(({ WorkflowStudio }) => {
        wrapper.appendChild(WorkflowStudio());
      });
    } else if (page === 'agents') {
      import('./components/AgentStudio.js').then(({ AgentStudio }) => {
        wrapper.appendChild(AgentStudio());
      });
    } else if (page === 'mcp-cli') {
      import('./components/McpCliStudio.js').then(({ McpCliStudio }) => {
        wrapper.appendChild(McpCliStudio());
      });
    }
  }
}

app.innerHTML = '';
// Pass navigate to Header so links work
app.appendChild(Header(navigate));

contentArea = document.createElement('main');
contentArea.id = 'content-area';
contentArea.className = 'flex-1 relative w-full overflow-hidden flex flex-col bg-app-bg';
app.appendChild(contentArea);

// Initial Route
navigate('image');
initExternalResults();

// Event Listener for Navigation
window.addEventListener('navigate', (e) => {
  if (e.detail.page === 'settings') {
    import('./components/SettingsModal.js').then(({ SettingsModal }) => {
      document.body.appendChild(SettingsModal());
    });
  } else {
    navigate(e.detail.page);
  }
});
