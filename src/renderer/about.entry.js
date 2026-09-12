import './js/icons.js';
import './tailwind-output.css';
import './css/common.css';
import './css/about.css';
import { startRenderer } from './tauriBridge.js';

startRenderer(() => import('./js/aboutPage.js'));
