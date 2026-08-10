export function formatSize(sizeInBytes) {
    const size = Number(sizeInBytes);
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const unitIndex = Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1);
    const formatted = Number((size / Math.pow(1024, unitIndex)).toFixed(2));
    return `${formatted} ${units[unitIndex]}`;
}
