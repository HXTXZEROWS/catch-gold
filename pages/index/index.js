// pages/index/index.js —— 接宝小游戏核心逻辑（性能优化版）
const BEST_KEY = 'catch_gold_best_score';

// 游戏常量（全部抽到外层，避免每帧重新创建对象/函数）
const CFG = {
  GOLD_R_MIN: 8,           // 极小金块
  GOLD_R_MAX: 12,         // 极小金块
  GRAVITY: 0.10,          // 极轻：飘浮感，下落极慢
  PAD_H: 26,              // 接盘更高
  PAD_RATIO: 0.36,        // 接盘极宽（36%屏幕宽）
  PAD_MIN_W: 150,         // 最小宽度保证
  PAD_MAX_W: 280,         // 最大宽度
  PAD_MARGIN_BOTTOM: 100, // 往上提，留足反应时间
  SPAWN_INITIAL_MS: 2000, // 初始极慢掉落
  SPAWN_MIN_MS: 900,      // 即便高分也不会太快
  SPAWN_SPEED_PER_SCORE: 5, // 随分数加快得很少
  BOUNCE_SPEED_MIN: 1.2,  // 被接住后轻轻弹一下
  BOUNCE_ANGLE_MAX: Math.PI / 4, // 反弹较分散
  STARS_COUNT: 55,
  STAR_BASE_ALPHA: 0.35,
  STAR_DYNAMIC_ALPHA: 0.65,
  STAR_TWINKLE_SPEED: 0.055,
  SCORE_PAD_DEBOUNCE_MS: 140,
  ONE_FRAME_MS: 16.6667
};

// 复用渐变（按 key 缓存，只缓存颜色/stops 固定的渐变）
const _gradCache = Object.create(null);
function getLinearGradient(ctx, key, x0, y0, x1, y1, stops) {
  let g = _gradCache[key];
  if (!g) {
    g = ctx.createLinearGradient(x0, y0, x1, y1);
    for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    _gradCache[key] = g;
  }
  return g;
}
function getRadialGradient(ctx, key, cx, cy, r0, cx2, cy2, r1, stops) {
  let g = _gradCache[key];
  if (!g) {
    g = ctx.createRadialGradient(cx, cy, r0, cx2, cy2, r1);
    for (let i = 0; i < stops.length; i++) g.addColorStop(stops[i][0], stops[i][1]);
    _gradCache[key] = g;
  }
  return g;
}

Page({
  data: {
    score: 0,
    bestScore: 0,
    isPlaying: false,
    isPaused: false,
    isGameOver: false,
    isNewRecord: false
  },

  // ---------- Canvas 相关 ----------
  _canvas: null,
  _ctx: null,
  _dpr: 1,
  _width: 0,
  _height: 0,
  _rafId: 0,
  _lastTime: 0,
  _isRunning: false,

  // ---------- 布局缓存 ----------
  _padW: 120,
  _padY: 0,
  _pad: { x: 0, y: 0, w: 120, h: CFG.PAD_H, speed: 0 },
  _layoutKey: '',

  // ---------- 游戏对象 ----------
  _golds: [],
  _stars: [],
  _spawnTimer: 0,
  _spawnInterval: CFG.SPAWN_INITIAL_MS,
  _elapsed: 0,
  _scoreBonus: 0,

  // ---------- 分数节流 ----------
  _pendingScore: 0,
  _lastScoreDataAt: 0,

  // ---------- 触摸控制 ----------
  _touching: false,
  _touchLastX: 0,
  _touchScale: 1,

  // ---------- 生命周期 ----------
  onLoad() {
    this._loadBestScore();
  },

  onReady() {
    this._initCanvas();
  },

  onUnload() {
    this._stopLoop();
  },

  onHide() {
    if (this.data.isPlaying && !this.data.isPaused) {
      this._setPaused(true);
    }
  },

  onShow() {
    if (!this._canvas) return;
    if (this.data.isPlaying) {
      this._startLoop();
    } else {
      this._drawFrame();
    }
  },

  // ---------- 最高分读写 ----------
  _loadBestScore() {
    try {
      const v = wx.getStorageSync(BEST_KEY);
      this.setData({ bestScore: Number(v) || 0 });
    } catch (e) {
      this.setData({ bestScore: 0 });
    }
  },

  _saveBestScore(score) {
    try { wx.setStorageSync(BEST_KEY, Number(score) || 0); } catch (e) {}
  },

  // ---------- Canvas 初始化 ----------
  _getDeviceInfoOnce() {
    if (this._deviceInfo) return this._deviceInfo;
    let dpr = 1, ww = 375;
    try {
      if (wx.getDeviceInfo) {
        const d = wx.getDeviceInfo();
        dpr = d.pixelRatio || dpr;
      }
      if (wx.getWindowInfo) {
        const w = wx.getWindowInfo();
        ww = w.windowWidth || ww;
      }
    } catch (e) {
      try {
        const s = wx.getSystemInfoSync();
        dpr = s.pixelRatio || dpr;
        ww = s.windowWidth || ww;
      } catch (e2) {}
    }
    this._deviceInfo = { dpr: dpr, windowWidth: ww };
    return this._deviceInfo;
  },

  _initCanvas() {
    const query = wx.createSelectorQuery();
    query.select('#gameCanvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        if (!res || !res[0] || !res[0].node) {
          console.error('[接宝] Canvas 初始化失败！请确认：\n1. 微信开发者工具基础库 >= 2.9.0\n2. 微信开发者工具已开启「增强编译」\n3. 工具顶部菜单 → 设置 → 通用设置 → 增强编译 已勾选');
          return;
        }

        const canvas = res[0].node;
        const ctx = canvas.getContext('2d');
        const info = this._getDeviceInfoOnce();
        const dpr = info.dpr || 1;
        const cssW = Math.max(1, res[0].width || 1);
        const cssH = Math.max(1, res[0].height || 1);

        canvas.width = Math.floor(cssW * dpr);
        canvas.height = Math.floor(cssH * dpr);

        this._canvas = canvas;
        this._ctx = ctx;
        this._dpr = dpr;
        this._width = cssW;
        this._height = cssH;

        // 触控映射（只算一次）
        this._touchScale = cssW / Math.max(1, info.windowWidth || cssW);

        // 布局（只算一次）
        this._layoutKey = cssW + 'x' + cssH;
        this._padW = Math.max(CFG.PAD_MIN_W, Math.min(CFG.PAD_MAX_W, cssW * CFG.PAD_RATIO));
        this._padY = Math.max(60, cssH - CFG.PAD_MARGIN_BOTTOM);

        // 星空（只生成一次）
        this._stars.length = 0;
        for (let i = 0; i < CFG.STARS_COUNT; i++) {
          this._stars.push({
            x: Math.random() * cssW,
            y: Math.random() * cssH,
            r: Math.random() * 1.2 + 0.3,
            twinkle: Math.random() * Math.PI * 2
          });
        }

        this._resetWorld();
        this._drawFrame();
      });
  },

  _ensureCtx() {
    return this._ctx || null;
  },

  // ---------- 世界重置 ----------
  _resetWorld() {
    this._pad = {
      x: Math.max(20, (this._width - this._padW) / 2),
      y: this._padY,
      w: this._padW,
      h: CFG.PAD_H,
      speed: 0
    };
    this._golds.length = 0;
    this._elapsed = 0;
    this._spawnTimer = 0;
    this._spawnInterval = CFG.SPAWN_INITIAL_MS;
    this._scoreBonus = 0;
    this._pendingScore = 0;
    this._lastScoreDataAt = 0;
  },

  // ---------- 开始 / 暂停 / 重新开始 ----------
  startGame() {
    this.setData({
      score: 0, isPlaying: true, isPaused: false, isGameOver: false, isNewRecord: false
    });
    this._resetWorld();
    if (!this._canvas) {
      const that = this;
      setTimeout(() => { that._initCanvas(); that._startLoop(); }, 100);
    } else {
      this._startLoop();
    }
  },

  restartGame() {
    this.setData({
      score: 0, isPlaying: true, isPaused: false, isGameOver: false, isNewRecord: false
    });
    this._resetWorld();
    if (!this._canvas) {
      const that = this;
      setTimeout(() => { that._initCanvas(); that._startLoop(); }, 100);
    } else {
      this._startLoop();
    }
  },

  togglePause() {
    if (!this.data.isPlaying) return;
    this._setPaused(!this.data.isPaused);
  },

  _setPaused(paused) {
    this.setData({ isPaused: paused });
    if (paused) { this._stopLoop(); } else { this._startLoop(); }
  },

  _gameOver() {
    this._stopLoop();
    if (this._pendingScore > 0) {
      this.setData({ score: this.data.score + this._pendingScore });
      this._pendingScore = 0;
    }
    const cur = this.data.score;
    const best = this.data.bestScore;
    let isNew = false;
    if (cur > best) {
      isNew = true;
      this._saveBestScore(cur);
      this.setData({ bestScore: cur });
    }
    this.setData({
      isPlaying: false, isGameOver: true, isPaused: false, isNewRecord: isNew
    });
    try { wx.vibrateShort && wx.vibrateShort({ type: 'heavy' }); } catch (e) {}
  },

  // ---------- 游戏主循环 ----------
  _startLoop() {
    this._isRunning = true;
    this._rafId = 0;
    if (!this._canvas) return;
    this._lastTime = Date.now();
    const that = this;
    const loop = () => {
      if (!that._isRunning || !that._canvas) { that._rafId = 0; return; }
      const now = Date.now();
      const dt = Math.min(50, now - that._lastTime);
      that._lastTime = now;
      that._update(dt);
      that._drawFrame();
      that._rafId = that._canvas.requestAnimationFrame(loop);
    };
    this._rafId = this._canvas.requestAnimationFrame(loop);
  },

  _stopLoop() {
    this._isRunning = false;
    const id = this._rafId;
    this._rafId = 0;
    if (id && this._canvas && this._canvas.cancelAnimationFrame) {
      try { this._canvas.cancelAnimationFrame(id); } catch (e) {}
    }
  },

  // ---------- 更新逻辑 ----------
  _update(dt) {
    const W = this._width, H = this._height;
    const pad = this._pad;
    const golds = this._golds;
    const oneF = CFG.ONE_FRAME_MS;

    // 难度递增
    const newInterval = CFG.SPAWN_INITIAL_MS - this.data.score * CFG.SPAWN_SPEED_PER_SCORE;
    this._spawnInterval = newInterval < CFG.SPAWN_MIN_MS ? CFG.SPAWN_MIN_MS : newInterval;

    this._spawnTimer += dt;
    while (this._spawnTimer >= this._spawnInterval) {
      this._spawnTimer -= this._spawnInterval;
      this._spawnOne();
    }

    let pendingInc = 0;
    for (let i = 0; i < golds.length; i++) {
      const g = golds[i];
      const t = dt / oneF;

      g.vy += CFG.GRAVITY * t;
      g.y += g.vy * t;
      g.x += g.vx * t;

      // 左右边界反弹
      if (g.x - g.r < 0) { g.x = g.r; if (g.vx < 0) g.vx = -g.vx; }
      if (g.x + g.r > W) { g.x = W - g.r; if (g.vx > 0) g.vx = -g.vx; }

      // 接盘碰撞
      const hit = g.x >= pad.x && g.x <= pad.x + pad.w &&
                  g.y + g.r >= pad.y && g.y - g.r <= pad.y + pad.h;

      if (hit) {
        this._scoreBonus += 1;
        pendingInc += 1 + ((this._scoreBonus / 5) | 0);
        const angle = (Math.random() - 0.5) * CFG.BOUNCE_ANGLE_MAX;
        const v2 = Math.hypot(g.vx, g.vy) * 0.9 + CFG.BOUNCE_SPEED_MIN;
        g.vx = Math.sin(angle) * v2;
        g.vy = -Math.abs(Math.cos(angle) * v2);
        g.y = pad.y - g.r;
      }
      // 金块落底 → 游戏结束
      if (g.y - g.r > H) {
        if (pendingInc > 0) {
          this._pendingScore += pendingInc;
          pendingInc = 0;
          this._flushScore();
        }
        this._gameOver();
        return;
      }
    }

    // 原地压缩
    let w = 0;
    for (let i = 0; i < golds.length; i++) {
      if (golds[i].y - golds[i].r <= H) golds[w++] = golds[i];
    }
    golds.length = w;

    // 节流加分
    if (pendingInc > 0) {
      this._pendingScore += pendingInc;
      this._flushScore();
    } else {
      this._scoreBonus = 0;
    }

    // 接盘惯性
    if (!this._touching) {
      pad.x += pad.speed * dt / oneF;
      pad.speed *= Math.pow(0.9, dt / oneF);
      if (Math.abs(pad.speed) < 0.05) pad.speed = 0;
    }

    // 接盘边界
    if (pad.x < 0) pad.x = 0;
    if (pad.x + pad.w > W) pad.x = W - pad.w;

    // 星空闪烁
    const stars = this._stars;
    for (let i = 0; i < stars.length; i++) {
      stars[i].twinkle += CFG.STAR_TWINKLE_SPEED;
    }
  },

  _flushScore() {
    const now = Date.now();
    if (this._pendingScore <= 0) return;
    if (now - this._lastScoreDataAt >= CFG.SCORE_PAD_DEBOUNCE_MS) {
      this.setData({ score: this.data.score + this._pendingScore });
      this._pendingScore = 0;
      this._lastScoreDataAt = now;
    }
  },

  _spawnOne() {
    const r = CFG.GOLD_R_MIN + Math.random() * (CFG.GOLD_R_MAX - CFG.GOLD_R_MIN);
    this._golds.push({
      x: 24 + Math.random() * (this._width - 48),
      y: -r,
      r: r,
      vx: (Math.random() - 0.5) * 1.8,
      vy: 1.2 + Math.random() * 1.2
    });
  },

  // ---------- 渲染（每帧） ----------
  _drawFrame() {
    const ctx = this._ensureCtx();
    if (!ctx) return;

    const W = this._width, H = this._height;
    const dpr = this._dpr;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W * dpr, H * dpr);

    this._drawBackground(ctx, W, H);

    const stars = this._stars;
    for (let i = 0; i < stars.length; i++) {
      const s = stars[i];
      ctx.globalAlpha = CFG.STAR_BASE_ALPHA + Math.abs(Math.sin(s.twinkle)) * CFG.STAR_DYNAMIC_ALPHA;
      ctx.fillStyle = '#e8f2ff';
      ctx.beginPath();
      ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const golds = this._golds;
    for (let i = 0; i < golds.length; i++) {
      this._drawGold(ctx, golds[i]);
    }

    this._drawPad(ctx, this._pad);
  },

  _drawBackground(ctx, W, H) {
    const key = this._layoutKey;
    const bg = getLinearGradient(ctx, 'bg:' + key, 0, 0, 0, H,
      [[0, '#0a0f2c'], [0.55, '#080c26'], [1, '#03061a']]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);

    const neb1 = getRadialGradient(ctx, 'neb1:' + key, W * 0.25, H * 0.15, 10, W * 0.25, H * 0.15, W * 0.75,
      [[0, 'rgba(76, 201, 255, 0.22)'], [1, 'rgba(0, 0, 0, 0)']]);
    ctx.fillStyle = neb1; ctx.fillRect(0, 0, W, H);

    const neb2 = getRadialGradient(ctx, 'neb2:' + key, W * 0.8, H * 0.05, 10, W * 0.8, H * 0.05, W * 0.5,
      [[0, 'rgba(255, 211, 61, 0.12)'], [1, 'rgba(0, 0, 0, 0)']]);
    ctx.fillStyle = neb2; ctx.fillRect(0, 0, W, H);
  },

  _drawGold(ctx, g) {
    const r = g.r, x = g.x, y = g.y;

    const glowR = r * 2.2;
    const grd = ctx.createRadialGradient(x, y, r * 0.2, x, y, glowR);
    grd.addColorStop(0, 'rgba(255, 211, 61, 0.55)');
    grd.addColorStop(1, 'rgba(255, 211, 61, 0)');
    ctx.fillStyle = grd;
    ctx.beginPath();
    ctx.arc(x, y, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.save();
    ctx.translate(x, y);
    const body = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.05, 0, 0, r);
    body.addColorStop(0, '#fff5cf');
    body.addColorStop(0.4, '#ffd33d');
    body.addColorStop(1, '#b67700');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = 'rgba(255, 255, 255, 0.75)';
    ctx.beginPath();
    ctx.arc(-r * 0.35, -r * 0.4, r * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  },

  _drawPad(ctx, pad) {
    const x = pad.x, y = pad.y, w = pad.w, h = pad.h;
    const r = h / 2;
    const cx = x + w / 2, cy = y + h / 2;

    ctx.save();
    ctx.translate(cx, cy);

    const glowKey = 'padGlow:' + this._layoutKey;
    const glow = getRadialGradient(ctx, glowKey, 0, 0, 6, 0, 0, Math.max(w, 1) * 0.9,
      [[0, 'rgba(76, 201, 255, 0.55)'], [1, 'rgba(76, 201, 255, 0)']]);
    ctx.fillStyle = glow;
    ctx.fillRect(-w / 2 - 30, -h / 2 - 20, w + 60, h + 40);

    ctx.beginPath();
    ctx.fillStyle = '#1b79c9';
    ctx.moveTo(-w / 2 + r, -h / 2);
    ctx.lineTo(w / 2 - r, -h / 2);
    ctx.arc(w / 2 - r, 0, r, -Math.PI / 2, Math.PI / 2);
    ctx.lineTo(-w / 2 + r, h / 2);
    ctx.arc(-w / 2 + r, 0, r, Math.PI / 2, -Math.PI / 2);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.fillStyle = 'rgba(76, 201, 255, 0.75)';
    ctx.moveTo(-w / 2 + r, -h / 2 + 3);
    ctx.lineTo(w / 2 - r, -h / 2 + 3);
    ctx.arc(w / 2 - r, r + 3 - h / 2, r - 3, -Math.PI / 2, 0);
    ctx.arc(-w / 2 + r, r + 3 - h / 2, r - 3, Math.PI, Math.PI / 2, true);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  },

  // ---------- 触摸控制 ----------
  onTouchStart(e) {
    if (!e.touches || !e.touches[0]) return;
    this._touching = true;
    this._touchLastX = e.touches[0].clientX;
  },

  onTouchMove(e) {
    if (!this._touching || !e.touches || !e.touches[0]) return;
    const dx = e.touches[0].clientX - this._touchLastX;
    this._touchLastX = e.touches[0].clientX;
    const move = dx * this._touchScale;
    this._pad.x += move;
    this._pad.speed = move / 4;
  },

  onTouchEnd() {
    this._touching = false;
  },

  // ---------- 截图 ----------
  _ensureCloud() {
    if (typeof getApp === 'undefined') return false;
    const app = getApp();
    if (!app || !wx.cloud) return false;
    if (app.globalData && app.globalData.cloudInited) return true;
    try {
      wx.cloud.init({ env: 'manual-env-please', traceUser: true });
      if (app.globalData) app.globalData.cloudInited = true;
      return true;
    } catch (e) { return false; }
  },

  saveScreenshot() {
    const canvas = this._canvas;
    if (!canvas) { wx.showToast({ title: '画布未就绪', icon: 'none' }); return; }

    wx.showLoading({ title: '生成截图...' });
    let loadingOn = true;

    wx.canvasToTempFilePath({
      canvas: canvas,
      x: 0, y: 0,
      width: this._width, height: this._height,
      destWidth: Math.floor(this._width * 2),
      destHeight: Math.floor(this._height * 2),
      fileType: 'png', quality: 1,
      success: (res) => {
        const tmp = res.tempFilePath;
        if (loadingOn) { wx.hideLoading(); loadingOn = false; }
        if (!this._uploadToCloud(tmp)) this._saveToAlbum(tmp);
      },
      fail: () => {
        if (loadingOn) { wx.hideLoading(); loadingOn = false; }
        wx.showToast({ title: '截图失败', icon: 'none' });
      }
    }, this);
  },

  _uploadToCloud(tmp) {
    if (!this._ensureCloud() || !wx.cloud.uploadFile) return false;
    try {
      const suffix = new Date().toISOString().replace(/[:.]/g, '-');
      wx.showLoading({ title: '上传云存储...' });
      let loadingOn = true;
      wx.cloud.uploadFile({
        cloudPath: 'catch-gold/screenshots/' + suffix + '-' + this.data.score + '.png',
        filePath: tmp,
        success: () => { if (loadingOn) { wx.hideLoading(); loadingOn = false; } wx.showModal({ title: '上传成功', content: '已保存到云存储', showCancel: false, confirmText: '好' }); },
        fail: () => { if (loadingOn) { wx.hideLoading(); loadingOn = false; } this._saveToAlbum(tmp); }
      });
      return true;
    } catch (e) { return false; }
  },

  _saveToAlbum(tmp) {
    wx.saveImageToPhotosAlbum({
      filePath: tmp,
      success: () => wx.showToast({ title: '已保存到相册', icon: 'success' }),
      fail: (err) => {
        if (err && err.errMsg && /auth/i.test(err.errMsg)) {
          wx.showModal({ title: '需要相册权限', content: '请在设置中允许保存到相册', confirmText: '去设置',
            success: (r) => { if (r.confirm && wx.openSetting) wx.openSetting(); } });
        } else {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      }
    });
  }
});
