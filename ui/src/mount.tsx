import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { enableTheme } from './bridge';
import './styles.css';

export function mount(node: ReactNode): void {
  enableTheme();
  const el = document.getElementById('root');
  if (!el) throw new Error('#root missing');
  createRoot(el).render(<StrictMode>{node}</StrictMode>);
}
