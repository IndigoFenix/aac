import { createRoot } from 'react-dom/client';
import SpaceTraderApp from './SpaceTraderApp';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(<SpaceTraderApp />);
