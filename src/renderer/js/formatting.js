export function formatSize(sizeInBytes) {
    const size = Number(sizeInBytes);
    if (!Number.isFinite(size) || size <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
    const unitIndex = Math.max(0, Math.min(Math.floor(Math.log(size) / Math.log(1024)), units.length - 1));
    const formatted = Number((size / Math.pow(1024, unitIndex)).toFixed(2));
    return `${formatted} ${units[unitIndex]}`;
}

export function formatBackupDate(backupDate) {
    return String(backupDate || '').replace(/^(\d{4})-(\d{1,2})-(\d{1,2})_(\d{1,2})-(\d{1,2})(?:-(\d{1,2}))?$/, (match, year, month, day, hour, minute, second = '00') => (
        `${year}/${month.padStart(2, '0')}/${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}:${second.padStart(2, '0')}`
    ));
}
