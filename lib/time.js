const pad = (value) => String(value).padStart(2, '0');

/**
 * 快照 / 导入批次的时间戳：**本地时间**，格式 YYYY-MM-DDTHH-mm-ss。
 * 用作目录名与备份文件名，因此不写冒号和空格（Windows 不允许冒号），
 * 同时保持字典序与时间序一致。
 */
export function stampNow(now = Date.now()) {
  const d = new Date(now);
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    'T' + pad(d.getHours()) + '-' + pad(d.getMinutes()) + '-' + pad(d.getSeconds())
  );
}

const LOCAL_STAMP = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})$/;

/**
 * 给人看的时间：yyyy-MM-dd HH:mm:ss（本地时区）。
 * - 本插件自己的 stamp 直接按字面拆开，不做时区换算（它本来就是本地时间）；
 * - 真 ISO（含 Z 或偏移，例如状态文件里的 updatedAt）解析后转本地时间；
 * - 解析不了就原样返回，绝不让显示层抛错。
 */
export function formatStamp(stamp) {
  const raw = String(stamp == null ? '' : stamp).trim();
  if (!raw) return '';
  const local = LOCAL_STAMP.exec(raw);
  if (local) {
    return local[1] + '-' + local[2] + '-' + local[3] + ' ' + local[4] + ':' + local[5] + ':' + local[6];
  }
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return (
    d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
    ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
  );
}
