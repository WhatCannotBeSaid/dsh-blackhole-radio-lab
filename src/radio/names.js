/**
 * Word pools for the mock stations.
 *
 * The names are fictional by construction — a stem from one pool plus a suffix
 * from another — and the panel labels every one of them as demo data. The pools
 * are wide enough that 2,000 records do not collapse into "Radio 1…2000": the
 * generator combines stems, cities and suffixes, and a collision resolver only
 * appends a district when a combination is already taken.
 *
 * Region and language pairs are plausible rather than authoritative: this is a
 * demo catalogue, not a mirror of the real broadcasting landscape.
 */

/** [zh, en, language-zh, language-en, city, city, ...] */
const COUNTRY_TABLE = [
  ['中国', 'China', '普通话', 'Mandarin', '北京', '上海', '广州', '成都', '杭州', '西安'],
  ['中国香港', 'Hong Kong', '粤语', 'Cantonese', '香港', '九龙', '新界'],
  ['中国台湾', 'Taiwan', '普通话', 'Mandarin', '台北', '高雄', '台中'],
  ['日本', 'Japan', '日语', 'Japanese', '东京', '大阪', '京都', '札幌', '福冈'],
  ['韩国', 'South Korea', '韩语', 'Korean', '首尔', '釜山', '仁川'],
  ['印度', 'India', '印地语', 'Hindi', '孟买', '德里', '班加罗尔', '加尔各答'],
  ['新加坡', 'Singapore', '英语', 'English', '新加坡'],
  ['印度尼西亚', 'Indonesia', '印尼语', 'Indonesian', '雅加达', '万隆', '泗水'],
  ['泰国', 'Thailand', '泰语', 'Thai', '曼谷', '清迈'],
  ['越南', 'Vietnam', '越南语', 'Vietnamese', '河内', '胡志明市'],
  ['菲律宾', 'Philippines', '菲律宾语', 'Filipino', '马尼拉', '宿务'],
  ['马来西亚', 'Malaysia', '马来语', 'Malay', '吉隆坡', '槟城'],
  ['澳大利亚', 'Australia', '英语', 'English', '悉尼', '墨尔本', '珀斯', '布里斯班'],
  ['新西兰', 'New Zealand', '英语', 'English', '奥克兰', '惠灵顿'],
  ['美国', 'United States', '英语', 'English', '纽约', '芝加哥', '洛杉矶', '西雅图', '奥斯汀'],
  ['加拿大', 'Canada', '英语', 'English', '多伦多', '蒙特利尔', '温哥华'],
  ['墨西哥', 'Mexico', '西班牙语', 'Spanish', '墨西哥城', '瓜达拉哈拉'],
  ['巴西', 'Brazil', '葡萄牙语', 'Portuguese', '圣保罗', '里约热内卢', '巴西利亚'],
  ['阿根廷', 'Argentina', '西班牙语', 'Spanish', '布宜诺斯艾利斯', '科尔多瓦'],
  ['英国', 'United Kingdom', '英语', 'English', '伦敦', '曼彻斯特', '格拉斯哥', '布里斯托'],
  ['爱尔兰', 'Ireland', '英语', 'English', '都柏林', '科克'],
  ['法国', 'France', '法语', 'French', '巴黎', '里昂', '马赛', '南特'],
  ['德国', 'Germany', '德语', 'German', '柏林', '汉堡', '慕尼黑', '科隆'],
  ['奥地利', 'Austria', '德语', 'German', '维也纳', '萨尔茨堡'],
  ['荷兰', 'Netherlands', '荷兰语', 'Dutch', '阿姆斯特丹', '鹿特丹'],
  ['比利时', 'Belgium', '法语', 'French', '布鲁塞尔', '安特卫普'],
  ['西班牙', 'Spain', '西班牙语', 'Spanish', '马德里', '巴塞罗那', '塞维利亚'],
  ['葡萄牙', 'Portugal', '葡萄牙语', 'Portuguese', '里斯本', '波尔图'],
  ['意大利', 'Italy', '意大利语', 'Italian', '罗马', '米兰', '那不勒斯', '都灵'],
  ['希腊', 'Greece', '希腊语', 'Greek', '雅典', '塞萨洛尼基'],
  ['波兰', 'Poland', '波兰语', 'Polish', '华沙', '克拉科夫'],
  ['捷克', 'Czechia', '捷克语', 'Czech', '布拉格', '布尔诺'],
  ['瑞典', 'Sweden', '瑞典语', 'Swedish', '斯德哥尔摩', '哥德堡'],
  ['挪威', 'Norway', '挪威语', 'Norwegian', '奥斯陆', '卑尔根'],
  ['丹麦', 'Denmark', '丹麦语', 'Danish', '哥本哈根', '奥胡斯'],
  ['芬兰', 'Finland', '芬兰语', 'Finnish', '赫尔辛基', '坦佩雷'],
  ['冰岛', 'Iceland', '冰岛语', 'Icelandic', '雷克雅未克'],
  ['俄罗斯', 'Russia', '俄语', 'Russian', '莫斯科', '圣彼得堡'],
  ['土耳其', 'Turkey', '土耳其语', 'Turkish', '伊斯坦布尔', '安卡拉'],
  ['埃及', 'Egypt', '阿拉伯语', 'Arabic', '开罗', '亚历山大'],
  ['摩洛哥', 'Morocco', '阿拉伯语', 'Arabic', '卡萨布兰卡', '马拉喀什'],
  ['南非', 'South Africa', '英语', 'English', '开普敦', '约翰内斯堡'],
  ['尼日利亚', 'Nigeria', '英语', 'English', '拉各斯', '阿布贾'],
  ['肯尼亚', 'Kenya', '斯瓦希里语', 'Swahili', '内罗毕', '蒙巴萨'],
  ['以色列', 'Israel', '希伯来语', 'Hebrew', '特拉维夫', '耶路撒冷'],
  ['阿联酋', 'United Arab Emirates', '阿拉伯语', 'Arabic', '迪拜', '阿布扎比'],
];

export const COUNTRIES = Object.freeze(
  COUNTRY_TABLE.map(([zh, en, languageZh, languageEn, ...cities]) => ({
    zh,
    en,
    languageZh,
    languageEn,
    cities,
  })),
);

/** Latin stems — short, evocative, and not tied to a real broadcaster. */
export const STEMS_EN = Object.freeze([
  'Aurora', 'Meridian', 'Tide', 'Nocturne', 'Kestrel', 'Saffron', 'Halcyon', 'Vela',
  'Cinder', 'Lumen', 'Marlow', 'Nimbus', 'Orchid', 'Pallas', 'Rook', 'Solstice',
  'Tamarind', 'Umbra', 'Vesper', 'Wren', 'Zephyr', 'Atlas', 'Borealis', 'Cobalt',
  'Drift', 'Ember', 'Fathom', 'Glint', 'Harbor', 'Ivory', 'Juniper', 'Kite',
  'Lantern', 'Moss', 'Nadir', 'Opal', 'Prairie', 'Quartz', 'Rill', 'Sable',
  'Thistle', 'Verdant', 'Willow', 'Yarrow', 'Zinnia', 'Aster', 'Basalt', 'Cirrus',
  'Dune', 'Echo', 'Fern', 'Garnet', 'Hollow', 'Indigo', 'Jasper', 'Kelpie',
  'Lichen', 'Mirage', 'Nettle', 'Obsidian', 'Pebble', 'Quill', 'Rosemary', 'Slate',
  'Tundra', 'Ulmus', 'Violet', 'Wander', 'Xylem', 'Yucca', 'Zephyrine', 'Alkali',
]);

/** CJK stems, used in Chinese naming patterns. */
export const STEMS_ZH = Object.freeze([
  '蓝鲸', '夜航', '曙光', '潮汐', '山脊', '松林', '微风', '长街',
  '岛屿', '星河', '灯塔', '沙丘', '苔原', '白鹭', '雾港', '赤道',
  '月台', '湖泊', '麦田', '岩层', '云梯', '霜降', '春分', '极昼',
  '半山', '北岸', '深井', '旧港', '青瓦', '远帆', '落霞', '南音',
]);

/** Suffixes that read as broadcaster names without claiming a real one. */
export const SUFFIXES = Object.freeze([
  'FM', 'Radio', '广播', '电台', '之声', 'Frequency', 'Waves', 'Signal',
  'Audio', 'Culture', 'Studio', 'Channel', '频率', '波段',
]);

/** Description templates per primary category, three variants each. */
const DESCRIPTION_TEMPLATES = {
  music: [
    '以当代与经典曲目编排的虚构音乐电台，演示数据，未接入真实电台服务。',
    '面向日常聆听的模拟音乐频率，节目单为演示用途生成。',
    '一份虚构的跨年代音乐歌单，用于展示电台空间分布。',
    'A fictional music format used to demo the station map; no real stream is attached.',
    'An invented day-long music rotation, generated for the demo catalogue.',
  ],
  news: [
    '整点播报与深度报道的虚构新闻电台，内容为演示数据。',
    '模拟的新闻编辑部频率，不包含真实新闻或真实主播。',
    'A fictional newsroom format for the demo; headlines are not real.',
    'An invented bulletin-and-feature station, generated for this prototype.',
  ],
  talk: [
    '访谈与长篇谈话的虚构电台，主持人与节目均为演示设定。',
    '模拟的播客与对谈频率，用于演示分类聚类。',
    'A fictional talk and podcast format; hosts and episodes are invented.',
  ],
  classical: [
    '以室内乐与交响作品为主的虚构古典频率，节目为演示编排。',
    '模拟的古典音乐电台，曲目信息不指向任何真实录音。',
    'An invented classical format for the demo catalogue.',
  ],
  jazz: [
    '虚构的爵士与即兴音乐电台，用于展示夜间的城市声景。',
    '模拟的爵士频率，演出与乐手均为演示设定。',
    'A fictional jazz format, generated for the station map.',
  ],
  electronic: [
    '虚构的电子音乐频率，涵盖氛围与舞曲的演示编排。',
    '模拟的电子音乐电台，不播放真实音轨。',
    'An invented electronic format for the demo.',
  ],
  world: [
    '汇集多地区音乐传统的虚构世界音乐电台，演示数据。',
    '模拟的世界音乐频率，地区与曲目均为虚构组合。',
    'A fictional world-music format for this prototype.',
  ],
  ambient: [
    '低强度环境音乐与长音的虚构电台，用于演示外围空间。',
    '模拟的环境音乐频率，适合作为空间背景。',
    'An invented ambient format, generated for the demo.',
  ],
};

/** Pick a name that is not already taken, appending a district on collision. */
export function makeName(rng, used, country, primaryCategory) {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const pattern = rng();
    const city = country.cities[Math.floor(rng() * country.cities.length) % country.cities.length];
    const suffix = SUFFIXES[Math.floor(rng() * SUFFIXES.length) % SUFFIXES.length];
    const useCjk = country.languageZh === '普通话' || country.languageZh === '粤语';
    const stemEn = STEMS_EN[Math.floor(rng() * STEMS_EN.length) % STEMS_EN.length];
    const stemZh = STEMS_ZH[Math.floor(rng() * STEMS_ZH.length) % STEMS_ZH.length];
    let name;

    if (pattern < 0.34) {
      name = useCjk && rng() < 0.7 ? `${stemZh}${suffix}` : `${stemEn} ${suffix}`;
    } else if (pattern < 0.58) {
      name = `${city} ${suffix}`;
    } else if (pattern < 0.76) {
      name = useCjk && rng() < 0.55 ? `${stemZh}${city.slice(0, 2)}` : `${stemEn} ${city}`;
    } else if (pattern < 0.88) {
      name = useCjk ? `${city}${stemZh}` : `${city} ${stemEn}`;
    } else {
      name = useCjk ? `${stemZh} · ${suffix}` : `${stemEn} · ${suffix}`;
    }

    // The genre occasionally appears in the name, which reads naturally and
    // keeps the catalogue from sounding like one naming machine.
    if (rng() < 0.1) {
      const tag = primaryCategory.en.split(/[\s&]+/)[0];
      name = `${name} ${tag}`;
    }

    if (!used.has(name)) {
      used.add(name);
      return name;
    }
  }

  // Deterministic fallback: city + serial. Never hit in practice, but the
  // generator must not return a duplicate even on a pathological seed.
  let serial = used.size + 1;
  let candidate = `${country.cities[0]} ${SUFFIXES[serial % SUFFIXES.length]} ${serial}`;
  while (used.has(candidate)) {
    serial += 1;
    candidate = `${country.cities[0]} ${SUFFIXES[serial % SUFFIXES.length]} ${serial}`;
  }
  used.add(candidate);
  return candidate;
}

/** One plausible demo blurb for a primary category, in the panel language. */
export function makeDescription(rng, primaryCategory, lang) {
  const templates = DESCRIPTION_TEMPLATES[primaryCategory.id] || DESCRIPTION_TEMPLATES.music;
  const english = templates.filter((text) => /^[A-Z]/.test(text));
  const chinese = templates.filter((text) => !/^[A-Z]/.test(text));
  const pool = lang === 'en' ? english : chinese;
  return pool[Math.floor(rng() * pool.length) % pool.length];
}
