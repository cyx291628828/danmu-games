/**
 * ============================================================================
 * games/xieyin/puzzles.js — 谐音梗猜词 · 内置题库
 * ============================================================================
 * 【谜题公式（与主播定稿一致）】
 *   上格 = 提示：只报物件名（"这是羊"），答案里的字一个不出现
 *   下格 = 同一物件 + 更丰富的 动作/数量/材质/表情/场景 变化，文字固定 "这是____"
 *   答案永远不上画面；空格槽数量 = 答案字数
 *
 * 【渲染 schema】面板 art = 有序列表（按 z 序渲染）：
 *   { t:'img', img:'1F411', x, y, w, rot?(deg), flt?('iron'=灰度铁化) }
 *   { t:'svg', s:'<path .../>' }   // viewBox 470x268 的内部标记，叠在图层位置
 *
 * 【自定义题】games/xieyin/custom_xieyin.json（数组，字段同上），按 id 覆盖内置题。
 * 【素材】OpenMoji（CC BY-SA 4.0）本地化于 public/assets/openmoji/<code>.svg
 * ============================================================================
 */
'use strict';

module.exports = [

  /* ═══════════ 成语 ═══════════ */

  {
    id: 'xy01', cat: '成语', answer: '掩耳盗铃', py: 'yǎn ěr dào líng',
    expl: '铃铛还在响，小偷却捂住自己的耳朵去偷 —— 自己骗自己',
    top: { cap: '这是铃铛', art: [{ t: 'img', img: '1F514', x: 160, y: 22, w: 150 }] },
    bot: {
      art: [
        { t: 'img', img: '1F649', x: 56, y: 28, w: 180 },
        { t: 'img', img: '1F514', x: 280, y: 64, w: 120 },
        { t: 'svg', s: '<g stroke="#ff9f43" stroke-width="4.5" fill="none" stroke-linecap="round"><path d="M262,104 Q250,124 262,144"/><path d="M246,94 Q228,124 246,154"/><path d="M416,104 Q428,124 416,144"/><path d="M432,94 Q450,124 432,154"/></g>' },
      ],
    },
  },
  {
    id: 'xy02', cat: '成语', answer: '对牛弹琴', py: 'duì niú tán qín',
    expl: '同一头牛，面对弹琴和音符只剩一个「？」—— 牛毫无反应本身就是谜底',
    top: { cap: '这是牛', art: [{ t: 'img', img: '1F404', x: 158, y: 22, w: 158 }] },
    bot: {
      art: [
        { t: 'img', img: '1F404', x: 52, y: 52, w: 160 },
        { t: 'img', img: '1F3B8', x: 300, y: 60, w: 120, rot: -14 },
        { t: 'img', img: '1F3B5', x: 268, y: 22, w: 52 },
        { t: 'img', img: '1F3B5', x: 396, y: 34, w: 40, rot: 12 },
        { t: 'svg', s: '<text x="222" y="74" text-anchor="middle" font-size="34" font-weight="900" fill="#2f2f45">？</text>' },
      ],
    },
  },
  {
    id: 'xy03', cat: '成语', answer: '一刀两断', py: 'yī dāo liǎng duàn',
    expl: '木棍断成两截、断口飞开 —— 「两」这个数量清晰可见',
    top: { cap: '这是刀', art: [{ t: 'img', img: '1F52A', x: 172, y: 18, w: 130, rot: -32 }] },
    bot: {
      art: [
        { t: 'img', img: '1F52A', x: 184, y: 14, w: 110, rot: -90 },
        { t: 'svg', s: '<g stroke="#2f2f45" stroke-width="4.5" stroke-linecap="round"><rect x="52" y="118" width="164" height="52" rx="14" fill="#b5835a"/><rect x="70" y="132" width="60" height="10" rx="5" fill="#8a5a2e" stroke="none"/><rect x="258" y="118" width="164" height="52" rx="14" fill="#b5835a"/><rect x="276" y="132" width="60" height="10" rx="5" fill="#8a5a2e" stroke="none"/><line x1="122" y1="88" x2="104" y2="102"/><line x1="235" y1="80" x2="235" y2="98"/><line x1="350" y1="88" x2="368" y2="102"/></g>' },
      ],
    },
  },
  {
    id: 'xy04', cat: '成语', answer: '拈花惹草', py: 'niān huā rě cǎo',
    expl: '上格完整的一朵花；下格同一种花长在草丛里，被手指「拈」住',
    top: {
      cap: '这是花',
      art: [{
        t: 'svg',
        s: '<g transform="translate(235,102)"><circle cx="0" cy="0" r="30" fill="#f7a6c0" stroke="#2f2f45" stroke-width="4.5"/><g fill="#f78fb0" stroke="#2f2f45" stroke-width="4"><circle cx="0" cy="-38" r="15"/><circle cx="36" cy="-12" r="15"/><circle cx="22" cy="30" r="15"/><circle cx="-22" cy="30" r="15"/><circle cx="-36" cy="-12" r="15"/></g><circle cx="0" cy="0" r="30" fill="#ffd166" stroke="#2f2f45" stroke-width="4.5"/><rect x="-4" y="28" width="8" height="70" rx="4" fill="#57a05c" stroke="#2f2f45" stroke-width="4"/><path d="M0,74 Q-30,66 -34,40 Q-6,44 0,74 Z" fill="#57a05c" stroke="#2f2f45" stroke-width="4"/></g>',
      }],
    },
    bot: {
      art: [
        { t: 'img', img: '1F90F', x: 76, y: 30, w: 120, rot: -24 },
        {
          t: 'svg',
          s: '<g transform="translate(282,122)"><rect x="-4" y="-28" width="8" height="80" rx="4" fill="#57a05c" stroke="#2f2f45" stroke-width="4"/><circle cx="0" cy="-56" r="24" fill="#ffd166" stroke="#2f2f45" stroke-width="4"/><g fill="#f78fb0" stroke="#2f2f45" stroke-width="3.5"><circle cx="0" cy="-84" r="11"/><circle cx="27" cy="-66" r="11"/><circle cx="17" cy="-36" r="11"/><circle cx="-17" cy="-36" r="11"/><circle cx="-27" cy="-66" r="11"/></g><circle cx="0" cy="-56" r="24" fill="#ffd166" stroke="#2f2f45" stroke-width="4"/><path d="M-2,44 Q-34,36 -40,8 Q-10,10 -2,44 Z" fill="#57a05c" stroke="#2f2f45" stroke-width="4"/><path d="M2,52 Q36,46 44,16 Q12,20 2,52 Z" fill="#57a05c" stroke="#2f2f45" stroke-width="4"/></g><g stroke="#2f2f45" stroke-width="4" fill="none" stroke-linecap="round"><path d="M96,196 q6,-26 22,-34 M112,198 q8,-20 20,-26 M366,196 q-6,-26 -22,-34 M350,198 q-8,-20 -20,-26 M210,204 q5,-18 16,-24 M246,204 q-5,-18 -16,-24"/></g>',
        },
      ],
    },
  },
  {
    id: 'xy05', cat: '成语', answer: '狐假虎威', py: 'hú jiǎ hǔ wēi',
    expl: '狐狸昂首走在老虎前面 —— 故事型成语直接演出来',
    top: { cap: '这是狐狸', art: [{ t: 'img', img: '1F98A', x: 168, y: 26, w: 140 }] },
    bot: {
      art: [
        { t: 'img', img: '1F42F', x: 196, y: 36, w: 186 },
        { t: 'img', img: '1F98A', x: 58, y: 60, w: 118 },
        { t: 'svg', s: '<g stroke="#2f2f45" stroke-width="3.5" fill="none" stroke-linecap="round" opacity=".65"><path d="M186,104 q14,6 20,18"/><path d="M178,124 q12,8 16,18"/></g>' },
      ],
    },
  },
  {
    id: 'xy06', cat: '成语', answer: '井底之蛙', py: 'jǐng dǐ zhī wā',
    expl: '同一只青蛙坐进井底抬头看天 —— 深井剖面 + 井口一小片天',
    top: { cap: '这是青蛙', art: [{ t: 'img', img: '1F438', x: 172, y: 26, w: 130 }] },
    bot: {
      dark: true,
      art: [
        {
          t: 'svg',
          s: '<rect x="105" y="-40" width="260" height="348" fill="#7a5236" stroke="#2f2f45" stroke-width="4.5"/><rect x="145" y="-40" width="180" height="268" fill="#3e4d6b"/><ellipse cx="235" cy="228" rx="90" ry="20" fill="#5d7296"/><g stroke="#2f2f45" stroke-width="4" opacity=".5"><line x1="125" y1="20" x2="345" y2="20"/><line x1="125" y1="70" x2="345" y2="70"/><line x1="125" y1="120" x2="345" y2="120"/><line x1="125" y1="170" x2="345" y2="170"/></g><ellipse cx="235" cy="18" rx="86" ry="22" fill="#87ceeb" stroke="#2f2f45" stroke-width="4.5"/><circle cx="204" cy="12" r="9" fill="#fff7ec" stroke="#2f2f45" stroke-width="3.5"/>',
        },
        { t: 'img', img: '1F438', x: 186, y: 150, w: 100 },
      ],
    },
  },
  {
    id: 'xy07', cat: '成语', answer: '画蛇添足', py: 'huà shé tiān zú',
    expl: '同一条蛇，下一格多出了脚 —— 成语故事类「同一物体＋一个变化」',
    top: {
      cap: '这是蛇',
      art: [{
        t: 'svg',
        s: '<path d="M110,120 C150,62 215,62 255,105 C295,148 345,148 368,112" stroke="#2f2f45" stroke-width="21" fill="none" stroke-linecap="round"/><path d="M110,120 C150,62 215,62 255,105 C295,148 345,148 368,112" stroke="#57a05c" stroke-width="12" fill="none" stroke-linecap="round"/><g transform="translate(108,120)"><circle r="17" fill="#57a05c" stroke="#2f2f45" stroke-width="5"/><circle cx="-4" cy="-4" r="2.8" fill="#2f2f45"/><path d="M-16,2 L-32,8 M-32,8 L-38,4 M-32,8 L-37,12" stroke="#ff4d4d" stroke-width="3" fill="none" stroke-linecap="round"/></g>',
      }],
    },
    bot: {
      art: [
        {
          t: 'svg',
          s: '<path d="M110,120 C150,62 215,62 255,105 C295,148 345,148 368,112" stroke="#2f2f45" stroke-width="21" fill="none" stroke-linecap="round"/><path d="M110,120 C150,62 215,62 255,105 C295,148 345,148 368,112" stroke="#57a05c" stroke-width="12" fill="none" stroke-linecap="round"/><g transform="translate(108,120)"><circle r="17" fill="#57a05c" stroke="#2f2f45" stroke-width="5"/><circle cx="-4" cy="-4" r="2.8" fill="#2f2f45"/><path d="M-16,2 L-32,8 M-32,8 L-38,4 M-32,8 L-37,12" stroke="#ff4d4d" stroke-width="3" fill="none" stroke-linecap="round"/></g><g stroke="#2f2f45" stroke-width="7" stroke-linecap="round" fill="none"><path d="M170,86 L162,116 M162,116 L154,124 M162,116 L168,126"/><path d="M228,74 L228,104 M228,104 L220,112 M228,104 L236,112"/><path d="M292,120 L300,150 M300,150 L292,158 M300,150 L310,154"/><path d="M348,136 L358,164 M358,164 L350,172 M358,164 L368,168"/></g>',
        },
      ],
    },
  },
  {
    id: 'xy08', cat: '成语', answer: '津津有味', py: 'jīn jīn yǒu wèi',
    expl: '参考谜例同款：金子×2 捂鼻皱眉发臭 →「金金有味」→ 津津有味',
    top: {
      cap: '这是金子',
      art: [{
        t: 'svg',
        s: '<g transform="translate(235,112)"><rect x="-44" y="-52" width="88" height="28" rx="14" fill="#ffe08a" stroke="#2f2f45" stroke-width="4.5"/><rect x="-58" y="-32" width="116" height="50" rx="16" fill="#f6c344" stroke="#2f2f45" stroke-width="4.5"/><circle cx="-14" cy="-12" r="3.5" fill="#2f2f45"/><circle cx="14" cy="-12" r="3.5" fill="#2f2f45"/><path d="M-9,-2 Q0,6 9,-2" stroke="#2f2f45" stroke-width="3.5" fill="none" stroke-linecap="round"/><circle cx="-24" cy="-4" r="5" fill="#f7a6a6" opacity=".8"/><circle cx="24" cy="-4" r="5" fill="#f7a6a6" opacity=".8"/></g><g fill="#f6c344" stroke="#2f2f45" stroke-width="2.5"><path d="M150,52 L153,61 L162,64 L153,67 L150,76 L147,67 L138,64 L147,61 Z"/><path d="M322,44 L325,53 L334,56 L325,59 L322,68 L319,59 L310,56 L319,53 Z"/></g>',
      }],
    },
    bot: {
      art: [
        {
          t: 'svg',
          s: '<g transform="translate(150,150) rotate(-6)"><rect x="-38" y="-40" width="76" height="24" rx="12" fill="#ffe08a" stroke="#2f2f45" stroke-width="4.5"/><rect x="-50" y="-22" width="100" height="44" rx="15" fill="#f6c344" stroke="#2f2f45" stroke-width="4.5"/><path d="M-30,-12 Q-26,-18 -22,-12" stroke="#2f2f45" stroke-width="3.2" fill="none" stroke-linecap="round"/><path d="M22,-12 Q26,-18 30,-12" stroke="#2f2f45" stroke-width="3.2" fill="none" stroke-linecap="round"/><ellipse cx="0" cy="2" rx="4" ry="5.5" fill="#2f2f45"/><path d="M-14,12 Q0,4 14,12" stroke="#2f2f45" stroke-width="3.2" fill="none" stroke-linecap="round"/></g><g transform="translate(322,146) rotate(7)"><rect x="-38" y="-40" width="76" height="24" rx="12" fill="#ffe08a" stroke="#2f2f45" stroke-width="4.5"/><rect x="-50" y="-22" width="100" height="44" rx="15" fill="#f6c344" stroke="#2f2f45" stroke-width="4.5"/><path d="M-30,-12 Q-26,-18 -22,-12" stroke="#2f2f45" stroke-width="3.2" fill="none" stroke-linecap="round"/><path d="M22,-12 Q26,-18 30,-12" stroke="#2f2f45" stroke-width="3.2" fill="none" stroke-linecap="round"/><ellipse cx="0" cy="2" rx="4" ry="5.5" fill="#2f2f45"/><path d="M-14,12 Q0,4 14,12" stroke="#2f2f45" stroke-width="3.2" fill="none" stroke-linecap="round"/></g><g stroke="#8d99ae" stroke-width="4" fill="none" stroke-linecap="round"><path d="M196,96 q-6,-16 4,-26"/><path d="M276,92 q6,-16 -4,-26"/><path d="M236,88 q0,-14 -8,-20"/></g><g fill="none" stroke="#2f2f45" stroke-width="3" stroke-linecap="round"><circle cx="150" cy="70" r="4"/><circle cx="322" cy="66" r="4"/></g>',
        },
      ],
    },
  },

  /* ═══════════ 歇后语 ═══════════ */

  {
    id: 'xy09', cat: '歇后语', answer: '一毛不拔', py: 'yī máo bù bá',
    expl: '同一只公鸡加灰度滤镜变「铁」，手拔毛满头大汗纹丝不动 —— 铁公鸡，一毛不拔',
    top: { cap: '这是公鸡', art: [{ t: 'img', img: '1F413', x: 165, y: 26, w: 160 }] },
    bot: {
      art: [
        { t: 'img', img: '1F413', x: 250, y: 36, w: 170, flt: 'iron' },
        { t: 'img', img: '1FAB6', x: 130, y: 56, w: 74, rot: -24 },
        { t: 'img', img: '1F4A6', x: 170, y: 140, w: 70 },
        { t: 'svg', s: '<g stroke="#2f2f45" stroke-width="4" stroke-linecap="round" opacity=".65"><path d="M208,96 L232,84"/><path d="M204,116 L230,112"/></g>' },
      ],
    },
  },
  {
    id: 'xy10', cat: '歇后语', answer: '有去无回', py: 'yǒu qù wú huí',
    expl: '包子沿虚线轨迹飞进狗嘴，肚子鼓起一个包 —— 只进不出，肉包子打狗',
    top: { cap: '这是包子', art: [{ t: 'img', img: '1F95F', x: 168, y: 26, w: 140 }] },
    bot: {
      art: [
        { t: 'img', img: '1F415', x: 262, y: 44, w: 190 },
        { t: 'img', img: '1F95F', x: 236, y: 66, w: 76, rot: 18 },
        {
          t: 'svg',
          s: '<path d="M36,196 Q120,58 232,92" stroke="#8d99ae" stroke-width="4.5" fill="none" stroke-dasharray="11 9" stroke-linecap="round"/><path d="M236,94 L212,82 L222,106 Z" fill="#8d99ae"/><g stroke="#8d99ae" stroke-width="3.5" fill="none" stroke-linecap="round" opacity=".8"><path d="M190,42 q-10,-8 -22,-6"/><path d="M198,26 q-14,-10 -30,-6"/></g>',
        },
      ],
    },
  },
  {
    id: 'xy11', cat: '歇后语', answer: '假慈悲', alias: ['猫哭耗子'], py: 'jiǎ cí bēi',
    expl: '猫一只眼假哭流泪、另一只眼偷瞄晕倒的老鼠 —— 猫哭耗子，假慈悲',
    top: { cap: '这是猫', art: [{ t: 'img', img: '1F431', x: 162, y: 30, w: 150 }] },
    bot: {
      art: [
        { t: 'img', img: '1F63F', x: 52, y: 22, w: 170 },
        { t: 'img', img: '1F42D', x: 296, y: 110, w: 112, rot: 84 },
        { t: 'img', img: '1F47B', x: 322, y: 18, w: 76, op: 0.92 },
        { t: 'svg', s: '<g stroke="#2f2f45" stroke-width="3.5" stroke-linecap="round"><path d="M330,142 L342,154 M342,142 L330,154"/></g>' },
      ],
    },
  },

  /* ═══════════ 明星 ═══════════ */

  {
    id: 'xy12', cat: '明星', answer: '杨幂', py: 'yáng mì',
    expl: '羊在舔蜂蜜 →「羊蜜」→ 杨幂',
    top: { cap: '这是羊', art: [{ t: 'img', img: '1F411', x: 170, y: 24, w: 158 }] },
    bot: {
      art: [
        { t: 'img', img: '1F411', x: 56, y: 44, w: 170 },
        { t: 'img', img: '1F36F', x: 292, y: 64, w: 104 },
        { t: 'svg', s: '<path d="M232,96 Q244,104 236,116" stroke="#2f2f45" stroke-width="3.5" fill="none" stroke-linecap="round"/><path d="M428,52 L432,61 L441,64 L432,67 L428,76 L424,67 L415,64 L424,61 Z" fill="#f6c344" stroke="#2f2f45" stroke-width="2.5"/>' },
      ],
    },
  },
  {
    id: 'xy13', cat: '明星', answer: '吴京', py: 'wú jīng',
    expl: '房子旁边鲸鱼出水 →「屋鲸」→ 吴京（屋 wū ≈ 吴 wú）',
    top: { cap: '这是屋', art: [{ t: 'img', img: '1F3E0', x: 166, y: 22, w: 140 }] },
    bot: {
      art: [
        { t: 'img', img: '1F3E0', x: 44, y: 76, w: 120 },
        { t: 'img', img: '1F40B', x: 236, y: 36, w: 196 },
        { t: 'svg', s: '<g stroke="#7ec8ff" stroke-width="4" fill="none" stroke-linecap="round"><path d="M300,214 q10,-14 24,-10"/><path d="M340,222 q12,-10 22,-6"/></g>' },
      ],
    },
  },

  /* ═══════════ 古代人物 ═══════════ */

  {
    id: 'xy14', cat: '古代人物', answer: '西施', py: 'xī shī',
    expl: '西瓜 + 狮子 →「西狮」→ 西施（狮 shī ≈ 施 shī）',
    top: { cap: '这是西瓜', art: [{ t: 'img', img: '1F349', x: 160, y: 24, w: 156 }] },
    bot: {
      art: [
        { t: 'img', img: '1F349', x: 56, y: 118, w: 120 },
        { t: 'img', img: '1F981', x: 226, y: 34, w: 168 },
      ],
    },
  },
  {
    id: 'xy15', cat: '古代人物', answer: '嫦娥', py: 'cháng é',
    expl: '香肠 + 鹅大眼瞪小眼 →「肠鹅」→ 嫦娥（肠 cháng ≈ 嫦）',
    top: { cap: '这是鹅', art: [{ t: 'img', img: '1FABF', x: 166, y: 20, w: 150 }] },
    bot: {
      art: [
        { t: 'img', img: '1F32D', x: 52, y: 76, w: 150, rot: -18 },
        { t: 'img', img: '1FABF', x: 238, y: 48, w: 150 },
        { t: 'svg', s: '<text x="392" y="60" text-anchor="middle" font-size="34" font-weight="900" fill="#2f2f45">？</text>' },
      ],
    },
  },
  {
    id: 'xy16', cat: '古代人物', answer: '岳飞', py: 'yuè fēi',
    expl: '夜空里月亮 + 飞鸟掠过 →「月飞」→ 岳飞（月 yuè ≈ 岳）',
    top: { cap: '这是月亮', dark: true, art: [{ t: 'img', img: '1F319', x: 168, y: 22, w: 136 }] },
    bot: {
      dark: true,
      art: [
        { t: 'img', img: '1F319', x: 44, y: 28, w: 110 },
        { t: 'img', img: '1F426', x: 268, y: 96, w: 110 },
        { t: 'svg', s: '<g stroke="#8d99ae" stroke-width="4" fill="none" stroke-linecap="round"><path d="M196,150 q-16,-6 -28,-18"/><path d="M188,178 q-18,-2 -32,-10"/></g><g fill="#fff" opacity=".9"><circle cx="392" cy="52" r="2.5"/><circle cx="424" cy="88" r="2"/><circle cx="360" cy="36" r="2"/></g>' },
      ],
    },
  },

  /* ═══════════ 物品 ═══════════ */

  {
    id: 'xy17', cat: '物品', answer: '热狗', py: 'rè gǒu',
    expl: '狗头顶冒火、热得直冒汗 →「热（的）狗」→ 热狗',
    top: { cap: '这是狗', art: [{ t: 'img', img: '1F415', x: 160, y: 26, w: 160 }] },
    bot: {
      art: [
        { t: 'img', img: '1F415', x: 150, y: 74, w: 170 },
        { t: 'img', img: '1F525', x: 206, y: 14, w: 74 },
        { t: 'svg', s: '<g stroke="#8d99ae" stroke-width="4" fill="none" stroke-linecap="round"><path d="M132,96 q-8,12 0,24"/><path d="M340,96 q8,12 0,24"/></g><g fill="#7ec8ff"><path d="M126,140 q-6,12 0,16 q6,-4 0,-16"/><path d="M346,140 q6,12 0,16 q-6,-4 0,-16"/></g>' },
      ],
    },
  },
  {
    id: 'xy18', cat: '物品', answer: '蛋挞', py: 'dàn tà',
    expl: '蛋顺着虚线飞向铁塔 →「蛋塔」→ 蛋挞（塔 tǎ ≈ 挞 tà）',
    top: { cap: '这是蛋', art: [{ t: 'img', img: '1F95A', x: 176, y: 26, w: 120 }] },
    bot: {
      art: [
        { t: 'img', img: '1F95A', x: 64, y: 96, w: 104, rot: -14 },
        { t: 'img', img: '1F5FC', x: 244, y: 16, w: 150 },
        { t: 'svg', s: '<path d="M212,150 Q236,120 260,142" stroke="#2f2f45" stroke-width="3.5" fill="none" stroke-linecap="round" stroke-dasharray="7 7"/>' },
      ],
    },
  },
  {
    id: 'xy19', cat: '物品', answer: '龙眼', py: 'lóng yǎn',
    expl: '龙盯着一只大眼睛 →「龙眼」，龙眼就是桂圆',
    top: { cap: '这是龙', art: [{ t: 'img', img: '1F409', x: 150, y: 22, w: 176 }] },
    bot: {
      art: [
        { t: 'img', img: '1F409', x: 52, y: 40, w: 170 },
        { t: 'img', img: '1F441', x: 262, y: 62, w: 130 },
        { t: 'svg', s: '<g stroke="#8d99ae" stroke-width="3.5" fill="none" stroke-linecap="round" opacity=".7"><path d="M238,120 q-10,10 0,20"/><path d="M226,138 q-8,8 0,16"/></g>' },
      ],
    },
  },

  /* ═══════════ 词语 ═══════════ */

  {
    id: 'xy20', cat: '词语', answer: '锦绣', py: 'jǐn xiù',
    expl: '同一块金子跳上舞台，聚光灯下举手拿麦「作秀」→「金秀」→ 锦绣（金 jīn ≈ 锦 jǐn，秀 xiù ＝ 绣 xiù）',
    top: {
      cap: '这是金子',
      art: [{
        t: 'svg',
        s: '<g transform="translate(235,112)"><rect x="-44" y="-52" width="88" height="28" rx="14" fill="#ffe08a" stroke="#2f2f45" stroke-width="4.5"/><rect x="-58" y="-32" width="116" height="50" rx="16" fill="#f6c344" stroke="#2f2f45" stroke-width="4.5"/><circle cx="-14" cy="-12" r="3.5" fill="#2f2f45"/><circle cx="14" cy="-12" r="3.5" fill="#2f2f45"/><path d="M-9,-2 Q0,6 9,-2" stroke="#2f2f45" stroke-width="3.5" fill="none" stroke-linecap="round"/><circle cx="-24" cy="-4" r="5" fill="#f7a6a6" opacity=".8"/><circle cx="24" cy="-4" r="5" fill="#f7a6a6" opacity=".8"/></g><g fill="#f6c344" stroke="#2f2f45" stroke-width="2.5"><path d="M150,52 L153,61 L162,64 L153,67 L150,76 L147,67 L138,64 L147,61 Z"/><path d="M322,44 L325,53 L334,56 L325,59 L322,68 L319,59 L310,56 L319,53 Z"/></g>',
      }],
    },
    bot: {
      dark: true,
      art: [
        {
          t: 'svg',
          s: '<polygon points="187,10 283,10 330,238 140,238" fill="#fff7cc" opacity=".2"/><rect x="205" y="2" width="60" height="12" rx="4" fill="#8d99ae" stroke="#2f2f45" stroke-width="3.5"/><path d="M10,4 Q34,134 12,264 L58,264 Q40,134 56,4 Z" fill="#e35d5d" stroke="#2f2f45" stroke-width="4"/><path d="M460,4 Q436,134 458,264 L412,264 Q430,134 414,4 Z" fill="#e35d5d" stroke="#2f2f45" stroke-width="4"/><rect x="60" y="236" width="350" height="30" fill="#17203a" stroke="#2f2f45" stroke-width="3.5"/>',
        },
        {
          t: 'svg',
          s: '<g transform="translate(226,186)"><rect x="-40" y="-44" width="80" height="26" rx="13" fill="#ffe08a" stroke="#2f2f45" stroke-width="4.5"/><rect x="-53" y="-25" width="106" height="46" rx="16" fill="#f6c344" stroke="#2f2f45" stroke-width="4.5"/><circle cx="-13" cy="-6" r="3.2" fill="#2f2f45"/><circle cx="13" cy="-6" r="3.2" fill="#2f2f45"/><path d="M-9,3 Q0,11 9,3" stroke="#2f2f45" stroke-width="3.2" fill="none" stroke-linecap="round"/><g stroke="#2f2f45" stroke-width="5" stroke-linecap="round"><line x1="-44" y1="-32" x2="-58" y2="-52"/><line x1="44" y1="-32" x2="58" y2="-52"/></g></g>',
        },
        { t: 'img', img: '1F3A4', x: 286, y: 130, w: 64, rot: 14 },
        {
          t: 'svg',
          s: '<g fill="#f6c344" stroke="#2f2f45" stroke-width="2.5"><path d="M158,96 L161,105 L170,108 L161,111 L158,120 L155,111 L146,108 L155,105 Z"/><path d="M300,72 L303,81 L312,84 L303,87 L300,96 L297,87 L288,84 L297,81 Z"/></g>',
        },
      ],
    },
  },

  /* ═══════════ 文字形谜 ═══════════ */

  {
    id: 'xy21', cat: '成语', answer: '话里有话', py: 'huà lǐ yǒu huà',
    expl: '经典文字形谜：大「话」套小「话」（红字暗示第二个话），不用任何插画',
    top: {
      cap: '这是话',
      art: [{
        t: 'svg',
        s: '<rect x="118" y="30" width="234" height="130" rx="26" fill="#fff" stroke="#2f2f45" stroke-width="4.5"/><path d="M172,158 L150,196 L206,158 Z" fill="#fff" stroke="#2f2f45" stroke-width="4.5" stroke-linejoin="round"/><text x="235" y="122" text-anchor="middle" font-size="76" font-weight="900" fill="#2f2f45">话</text>',
      }],
    },
    bot: {
      art: [{
        t: 'svg',
        s: '<text x="235" y="196" text-anchor="middle" font-size="150" font-weight="900" fill="#2f2f45">话</text><text x="252" y="188" text-anchor="middle" font-size="56" font-weight="900" fill="#e35d5d">话</text>',
      }],
    },
  },
];
