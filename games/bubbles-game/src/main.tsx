import { createRoot } from 'react-dom/client';
import BubblesGameApp from './BubblesGameApp';
import './index.css';

const root = document.getElementById('root');
if (!root) throw new Error('Missing #root element');
createRoot(root).render(<BubblesGameApp />);
