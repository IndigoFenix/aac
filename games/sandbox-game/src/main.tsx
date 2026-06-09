import { createRoot } from 'react-dom/client';
import SandboxGameApp from './SandboxGameApp';
import { loadOverrides } from './debug-config';
import './index.css';

// Apply any saved tuning overrides onto the live config BEFORE the engine reads
// them (so debug-panel tweaks persist across reloads).
loadOverrides();

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(<SandboxGameApp />);
