import {
    Archive,
    Ban,
    Check,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    CircleCheck,
    CircleHelp,
    CircleX,
    CloudDownload,
    CloudUpload,
    DatabaseZap,
    Download,
    EllipsisVertical,
    ExternalLink,
    Eye,
    FileInput,
    FolderOpen,
    FolderSearch,
    Globe,
    GitCompareArrows,
    Heart,
    HeartCrack,
    Info,
    ListChecks,
    LoaderCircle,
    Pencil,
    Plus,
    RefreshCw,
    RotateCcwClock,
    ScanSearch,
    Search,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Star,
    TimerReset,
    Trash2,
    TriangleAlert,
    Upload,
    UserRoundCog,
    WandSparkles,
    X
} from '@lucide/icons';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

const iconRegistry = new Map([
    Archive,
    Ban,
    Check,
    ChevronDown,
    ChevronRight,
    ChevronUp,
    CircleCheck,
    CircleHelp,
    CircleX,
    CloudDownload,
    CloudUpload,
    DatabaseZap,
    Download,
    EllipsisVertical,
    ExternalLink,
    Eye,
    FileInput,
    FolderOpen,
    FolderSearch,
    Globe,
    GitCompareArrows,
    Heart,
    HeartCrack,
    Info,
    ListChecks,
    LoaderCircle,
    Pencil,
    Plus,
    RefreshCw,
    RotateCcwClock,
    ScanSearch,
    Search,
    Settings,
    ShieldCheck,
    SlidersHorizontal,
    Star,
    TimerReset,
    Trash2,
    TriangleAlert,
    Upload,
    UserRoundCog,
    WandSparkles,
    X
].map(icon => [icon.name, icon]));

export function createIcon(iconName, options = {}) {
    const icon = iconRegistry.get(iconName);
    if (!icon) {
        return null;
    }

    const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
    svg.setAttribute('viewBox', `0 0 ${icon.size} ${icon.size}`);
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', String(options.strokeWidth || 1.8));
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    svg.classList.add('lucide-icon', `lucide-${icon.name}`);

    if (options.className) {
        svg.classList.add(...String(options.className).split(/\s+/).filter(Boolean));
    }

    icon.node.forEach(([tagName, attributes]) => {
        const child = document.createElementNS(SVG_NAMESPACE, tagName);
        Object.entries(attributes).forEach(([name, value]) => {
            if (name !== 'key') {
                child.setAttribute(name, String(value));
            }
        });
        svg.appendChild(child);
    });

    return svg;
}

export function renderIcon(container, iconName, options = {}) {
    if (!container) {
        return null;
    }

    const svg = createIcon(iconName, options);
    if (!svg) {
        container.replaceChildren();
        container.removeAttribute('data-rendered-icon');
        return null;
    }

    container.replaceChildren(svg);
    container.dataset.lucideIcon = iconName;
    container.dataset.renderedIcon = iconName;
    container.setAttribute('aria-hidden', 'true');
    return svg;
}

export function installIcons(root = document) {
    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.('[data-lucide-icon]')) {
        const iconName = root.dataset.lucideIcon;
        if (root.dataset.renderedIcon !== iconName) {
            renderIcon(root, iconName);
        }
    }

    root.querySelectorAll?.('[data-lucide-icon]').forEach(container => {
        const iconName = container.dataset.lucideIcon;
        if (container.dataset.renderedIcon !== iconName) {
            renderIcon(container, iconName);
        }
    });
}

function startIconObserver() {
    installIcons(document);
    const observer = new MutationObserver(mutations => {
        mutations.forEach(mutation => {
            mutation.addedNodes.forEach(node => {
                if (node.nodeType === Node.ELEMENT_NODE) {
                    installIcons(node);
                }
            });
        });
    });
    observer.observe(document.body, { childList: true, subtree: true });
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', startIconObserver, { once: true });
} else {
    startIconObserver();
}
