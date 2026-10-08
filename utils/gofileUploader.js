/**
 * utils/gofileUploader.js
 * 
 * 1. 文件名合法化与命名规范处理
 * 2. 纯 Node.js 高性能 ZIP 打包（仅最外层任务目录打包为单个 .zip，内部平铺）
 * 3. Node 18+ 原生 fetch + FormData Gofile 两步上传
 * 4. 无论成功或失败，finally 代码块全自动清理临时文件与 .zip，确保 VPS 磁盘 0 占用
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// CRC32 计算表
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  crcTable[i] = c >>> 0;
}

function calculateCrc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

/**
 * 剔除所有文件名与目录名中的系统非法字符（/ \ : * ? " < > |）
 */
function sanitizeFilename(name) {
  if (!name || typeof name !== 'string') return 'untitled';
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/_+/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/\s+/g, ' ')
    .trim() || 'untitled';
}

/**
 * 格式化单曲文件名
 * 单曲文件：${artist} - ${title}.alac
 */
function formatSongFilename(artist, title, ext = 'alac') {
  const cleanArtist = sanitizeFilename(artist);
  const cleanTitle = sanitizeFilename(title);
  return `${cleanArtist} - ${cleanTitle}.${ext}`;
}

/**
 * 格式化配套歌词文件名
 * 配套歌词：${artist} - ${title}.lrc
 */
function formatLyricsFilename(artist, title) {
  return formatSongFilename(artist, title, 'lrc');
}

/**
 * 格式化最外层 ZIP 打包文件名
 * - 单曲任务：${artist} - ${title}.zip
 * - 专辑任务：${albumName}.zip
 * - 播放列表（含共享歌单 pl.u-）或歌手：${playlistName}.zip 或 ${artist}.zip
 */
function formatZipFilename(taskType, info = {}) {
  if (taskType === 'song') {
    const cleanArtist = sanitizeFilename(info.artist || 'Unknown Artist');
    const cleanTitle = sanitizeFilename(info.title || 'Unknown Title');
    return `${cleanArtist} - ${cleanTitle}.zip`;
  }
  if (taskType === 'album') {
    return `${sanitizeFilename(info.albumName || 'Unknown Album')}.zip`;
  }
  if (taskType === 'playlist') {
    return `${sanitizeFilename(info.playlistName || info.name || 'Playlist')}.zip`;
  }
  if (taskType === 'artist') {
    return `${sanitizeFilename(info.artist || 'Artist')}.zip`;
  }
  return `${sanitizeFilename(info.name || 'Archive')}.zip`;
}

/**
 * 创建标准 ZIP 压缩包 (原生 Node.js 实现，零外部依赖，跨平台高兼容)
 * @param {Array<{ name: string, data: Buffer }>} fileList 文件平铺列表
 * @param {string} destZipPath 目标 .zip 路径
 */
async function createZipArchive(fileList, destZipPath) {
  const localHeaders = [];
  const centralRecords = [];
  let currentOffset = 0;

  for (const file of fileList) {
    const rawData = Buffer.isBuffer(file.data) ? file.data : Buffer.from(file.data);
    const uncompressedSize = rawData.length;
    const crc = calculateCrc32(rawData);

    // 采用 DEFLATE 压缩
    const compressedData = zlib.deflateRawSync(rawData);
    const compressedSize = compressedData.length;
    const filenameBuf = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');

    // 1. Local File Header (30 字节 + 名字 + 压缩内容)
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0); // Signature
    localHeader.writeUInt16LE(20, 4);          // Version needed (2.0)
    localHeader.writeUInt16LE(0x0800, 6);      // General purpose bit flag (UTF-8)
    localHeader.writeUInt16LE(8, 8);           // Compression method (Deflate)
    localHeader.writeUInt16LE(0, 10);          // Last mod time
    localHeader.writeUInt16LE(0, 12);          // Last mod date
    localHeader.writeUInt32LE(crc, 14);        // CRC-32
    localHeader.writeUInt32LE(compressedSize, 18);   // Compressed size
    localHeader.writeUInt32LE(uncompressedSize, 22); // Uncompressed size
    localHeader.writeUInt16LE(filenameBuf.length, 26); // Filename length
    localHeader.writeUInt16LE(0, 28);          // Extra field length

    const fullLocalEntry = Buffer.concat([localHeader, filenameBuf, compressedData]);
    localHeaders.push(fullLocalEntry);

    // 2. Central Directory Record (46 字节 + 名字)
    const centralRecord = Buffer.alloc(46);
    centralRecord.writeUInt32LE(0x02014b50, 0); // Signature
    centralRecord.writeUInt16LE(20, 4);         // Version made by
    centralRecord.writeUInt16LE(20, 6);         // Version needed
    centralRecord.writeUInt16LE(0x0800, 8);     // Bit flag (UTF-8)
    centralRecord.writeUInt16LE(8, 10);         // Compression method
    centralRecord.writeUInt16LE(0, 12);         // Time
    centralRecord.writeUInt16LE(0, 14);         // Date
    centralRecord.writeUInt32LE(crc, 16);       // CRC-32
    centralRecord.writeUInt32LE(compressedSize, 20);
    centralRecord.writeUInt32LE(uncompressedSize, 24);
    centralRecord.writeUInt16LE(filenameBuf.length, 28);
    centralRecord.writeUInt16LE(0, 30);         // Extra field length
    centralRecord.writeUInt16LE(0, 32);         // Comment length
    centralRecord.writeUInt16LE(0, 34);         // Disk number start
    centralRecord.writeUInt16LE(0, 36);         // Internal attributes
    centralRecord.writeUInt32LE(0, 38);         // External attributes
    centralRecord.writeUInt32LE(currentOffset, 42); // Relative offset of local header

    centralRecords.push(Buffer.concat([centralRecord, filenameBuf]));
    currentOffset += fullLocalEntry.length;
  }

  const allLocalEntries = Buffer.concat(localHeaders);
  const allCentralRecords = Buffer.concat(centralRecords);

  // 3. End of Central Directory Record (22 字节)
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);       // Signature
  eocd.writeUInt16LE(0, 4);                // Number of this disk
  eocd.writeUInt16LE(0, 6);                // Disk where central directory starts
  eocd.writeUInt16LE(fileList.length, 8);  // Number of central directory records on this disk
  eocd.writeUInt16LE(fileList.length, 10); // Total number of central directory records
  eocd.writeUInt32LE(allCentralRecords.length, 12); // Size of central directory
  eocd.writeUInt32LE(allLocalEntries.length, 16);   // Offset of start of central directory
  eocd.writeUInt16LE(0, 20);               // Comment length

  const finalZipBuffer = Buffer.concat([allLocalEntries, allCentralRecords, eocd]);
  
  await fs.promises.mkdir(path.dirname(destZipPath), { recursive: true });
  await fs.promises.writeFile(destZipPath, finalZipBuffer);
  return destZipPath;
}

/**
 * 将平铺目录中的所有文件打包为单一 .zip
 */
async function packageDirectoryToZip(sourceDir, destZipPath) {
  const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
  const fileList = [];

  for (const entry of entries) {
    if (entry.isFile()) {
      const filePath = path.join(sourceDir, entry.name);
      const data = await fs.promises.readFile(filePath);
      fileList.push({ name: entry.name, data });
    }
  }

  return createZipArchive(fileList, destZipPath);
}

/**
 * Gofile 步骤 a: 获取可用上传服务器
 * GET https://api.gofile.io/servers
 */
async function getGofileServer() {
  try {
    const res = await fetch('https://api.gofile.io/servers', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    
    if (json.status === 'ok' && json.data) {
      if (Array.isArray(json.data.servers) && json.data.servers.length > 0) {
        return json.data.servers[0].name;
      }
      if (typeof json.data.server === 'string') {
        return json.data.server;
      }
    }
  } catch (err) {
    // 若主接口不可用，尝试 fallback
  }
  return 'store1'; // 官方通用 fallback 节点
}

/**
 * Gofile 步骤 b: 上传 ZIP 文件流并返回 downloadPage
 * POST https://{server}.gofile.io/contents/uploadfile
 */
async function uploadZipToGofile(zipFilePath, serverName, options = {}) {
  const server = serverName || (await getGofileServer());
  const uploadUrl = `https://${server}.gofile.io/contents/uploadfile`;

  const fileData = await fs.promises.readFile(zipFilePath);
  const fileName = path.basename(zipFilePath);

  const form = new FormData();
  const fileBlob = new Blob([fileData], { type: 'application/zip' });
  form.append('file', fileBlob, fileName);

  if (options.token) {
    form.append('token', options.token);
  }
  if (options.folderId) {
    form.append('folderId', options.folderId);
  }

  const res = await fetch(uploadUrl, {
    method: 'POST',
    body: form,
    headers: options.headers || {}
  });

  if (!res.ok) {
    throw new Error(`Gofile upload failed: HTTP ${res.status} ${res.statusText}`);
  }

  const json = await res.json();
  if (json.status !== 'ok') {
    throw new Error(`Gofile upload error: ${json.message || JSON.stringify(json)}`);
  }

  const downloadPage = json.data?.downloadPage;
  const fileId = json.data?.fileId || json.data?.id;

  return {
    downloadPage,
    fileId,
    raw: json.data
  };
}

/**
 * 安全递归清理指定路径数组（文件或目录）
 */
async function cleanupPaths(paths) {
  for (const targetPath of paths) {
    if (!targetPath) continue;
    try {
      const stat = await fs.promises.stat(targetPath).catch(() => null);
      if (stat) {
        if (stat.isDirectory()) {
          await fs.promises.rm(targetPath, { recursive: true, force: true });
        } else {
          await fs.promises.unlink(targetPath);
        }
      }
    } catch {
      // 容错忽略
    }
  }
}

/**
 * 纯 Gofile 模式核心交付流程：
 * 1. 处于 Gofile 模式时，音频与 .lrc 写入临时工作目录
 * 2. 下载完毕后将最外层任务目录打成单个 .zip，调用 gofileUploader 上传
 * 3. 上传成功后将下载链接返回
 * 4. 无论成功或失败，在 finally 代码块中递归清理临时工作目录及本地 .zip，确保 VPS 磁盘 0 残留
 *
 * @param {Object} params
 * @param {Array<{ filename: string, content: Buffer|string }>} params.files 音频与歌词平铺文件列表
 * @param {string} params.zipFilename 压缩包文件名
 * @param {Function} [params.customUploader] 可选自定义上传函数 (供测试 mock)
 * @returns {Promise<{ ok: boolean, downloadPage: string, zipFilename: string }>}
 */
async function processGofileDelivery({ files, zipFilename, customUploader }) {
  const uniqueId = `gofile_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
  const baseTmpDir = path.join(os.tmpdir(), 'am_hook_tasks');
  const taskWorkDir = path.join(baseTmpDir, uniqueId);
  const cleanZipName = sanitizeFilename(zipFilename || 'download.zip');
  const destZipPath = path.join(baseTmpDir, `${uniqueId}_${cleanZipName}`);

  try {
    // 1. 创建临时工作目录并写入文件
    await fs.promises.mkdir(taskWorkDir, { recursive: true });

    const fileEntries = [];
    for (const f of files) {
      const cleanName = sanitizeFilename(f.filename);
      const filePath = path.join(taskWorkDir, cleanName);
      const data = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content);
      await fs.promises.writeFile(filePath, data);
      fileEntries.push({ name: cleanName, data });
    }

    // 2. 打包成单个 .zip
    await createZipArchive(fileEntries, destZipPath);

    // 3. 上传至 Gofile
    let uploadResult;
    if (typeof customUploader === 'function') {
      uploadResult = await customUploader(destZipPath);
    } else {
      const server = await getGofileServer();
      uploadResult = await uploadZipToGofile(destZipPath, server);
    }

    return {
      ok: true,
      downloadPage: uploadResult.downloadPage,
      zipFilename: cleanZipName,
      fileId: uploadResult.fileId
    };
  } finally {
    // 4. 无论成功或失败，在 finally 代码块中递归清理临时工作目录及本地 .zip，确保 VPS 磁盘 0 残留
    await cleanupPaths([taskWorkDir, destZipPath]);
  }
}

module.exports = {
  sanitizeFilename,
  formatSongFilename,
  formatLyricsFilename,
  formatZipFilename,
  calculateCrc32,
  createZipArchive,
  packageDirectoryToZip,
  getGofileServer,
  uploadZipToGofile,
  cleanupPaths,
  processGofileDelivery
};
