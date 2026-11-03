import { createRoot } from 'react-dom/client';
import { App, Launcher } from './App';
import './styles.css';
const launcher = new URLSearchParams(location.search).has('launcher');
document.body.classList.toggle('launcher-mode', launcher);
createRoot(document.getElementById('root')!).render(launcher ? <Launcher /> : <App />);
