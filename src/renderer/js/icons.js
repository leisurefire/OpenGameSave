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
    Cloud,
    CloudDownload,
    CloudUpload,
    Database,
    DatabaseZap,
    Download,
    EllipsisVertical,
    Eye,
    FileInput,
    FolderCog,
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
    Cloud,
    CloudDownload,
    CloudUpload,
    Database,
    DatabaseZap,
    Download,
    EllipsisVertical,
    Eye,
    FileInput,
    FolderCog,
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

// Reusable actions should be selected by intent instead of repeating Lucide
// names throughout the UI. This keeps the same action visually consistent and
// lets navigation/management actions use a different icon from opening a path.
export const ACTION_ICONS = Object.freeze({
    delete: Trash2.name,
    manageLocalData: FolderCog.name,
    openDirectory: FolderOpen.name,
    openRegistry: Database.name,
    selectDirectory: FolderSearch.name,
    selectFile: FileInput.name
});

export function getLocalSaveOpenIconRole(pathType) {
    // Files are intentionally revealed via their containing directory in the
    // main process, so both files and folders share the directory-open icon.
    return pathType === 'reg' ? 'openRegistry' : 'openDirectory';
}

function getContainerIconName(container) {
    const actionRole = container.dataset.actionIcon;
    if (actionRole) {
        return ACTION_ICONS[actionRole] || null;
    }
    return container.dataset.lucideIcon;
}

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
    const iconSelector = '[data-lucide-icon], [data-action-icon]';

    if (root.nodeType === Node.ELEMENT_NODE && root.matches?.(iconSelector)) {
        const iconName = getContainerIconName(root);
        if (root.dataset.renderedIcon !== iconName) {
            renderIcon(root, iconName);
        }
    }

    root.querySelectorAll?.(iconSelector).forEach(container => {
        const iconName = getContainerIconName(container);
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
