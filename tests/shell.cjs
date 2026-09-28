// 站内页面在外壳（src/ui/shell.html）的 iframe 中打开，播放条常驻在外壳上。
// 页面内容在返回的 Frame 中查找；播放条（#player）、地址栏、截图与视口仍在 Page 上。

/** 外壳中页面所在的 Frame（重新加载外壳后需要重新获取） */
exports.pageFrame = async (page) => (await page.waitForSelector('#frame')).contentFrame();

/** 打开站内页面，返回其所在的 Frame */
exports.openPage = async (page, url) => {
  await page.goto(url);
  return exports.pageFrame(page);
};
