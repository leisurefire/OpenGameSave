import './js/icons.js';
import './tailwind-output.css';
import './css/common.css';
import './css/modal-window.css';
import { startRenderer } from './tauriBridge.js';

startRenderer(() => import('./js/modalWindowPage.js'));
