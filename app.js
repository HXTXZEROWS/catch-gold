// app.js —— 小程序入口
// 云开发初始化放在「保存截图」时按需触发，避免游客模式/未开通云开发时启动报错
App({
  onLaunch() {
  },

  globalData: {
    version: '1.0.0',
    cloudInited: false
  }
});
