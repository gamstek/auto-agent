import { createRoot } from 'react-dom/client';
import './styles.css';
import { App } from './App';
import { Launcher } from './components/Launcher/Launcher';
const launcher = new URLSearchParams(location.search).has('launcher');
document.body.classList.toggle('launcher-mode', launcher);
createRoot(document.getElementById('root')!).render(launcher ? <Launcher /> : <App />);
