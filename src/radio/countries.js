/**
 * Display names for the country and language codes Radio Browser reports.
 *
 * The mock catalogue carries `{ zh, en }` for both, because it invents its own
 * plausible region/language pairs. Real records carry an ISO code and the
 * broadcaster's own spelling, so the mapping lives here — plain data plus a
 * lookup, no i18n library, nothing that touches the network.
 *
 * Coverage strategy, in order:
 *   1. `COUNTRY_NAMES` — every country in the mock catalogue plus the
 *      stations most present in Radio Browser, so the common cases are correct;
 *   2. `Intl.DisplayNames` when the engine has it — the rest still gets a real
 *      region name instead of a bare code;
 *   3. the code itself. A visible code is better than a blank panel.
 */

/** [code, zh, en, { code: [zh, en] }] — country name plus its common languages. */
const COUNTRY_TABLE = [
  ['CN', '中国', 'China', ['zh']],
  ['HK', '中国香港', 'Hong Kong'],
  ['MO', '中国澳门', 'Macao'],
  ['TW', '中国台湾', 'Taiwan'],
  ['JP', '日本', 'Japan', ['ja']],
  ['KR', '韩国', 'South Korea', ['ko']],
  ['KP', '朝鲜', 'North Korea', ['ko']],
  ['IN', '印度', 'India', ['hi', 'en']],
  ['SG', '新加坡', 'Singapore', ['en', 'zh', 'ms']],
  ['ID', '印度尼西亚', 'Indonesia', ['id']],
  ['TH', '泰国', 'Thailand', ['th']],
  ['VN', '越南', 'Vietnam', ['vi']],
  ['PH', '菲律宾', 'Philippines', ['tl']],
  ['MY', '马来西亚', 'Malaysia', ['ms']],
  ['AU', '澳大利亚', 'Australia', ['en']],
  ['NZ', '新西兰', 'New Zealand', ['en']],
  ['US', '美国', 'United States', ['en']],
  ['CA', '加拿大', 'Canada', ['en', 'fr']],
  ['MX', '墨西哥', 'Mexico', ['es']],
  ['BR', '巴西', 'Brazil', ['pt']],
  ['AR', '阿根廷', 'Argentina', ['es']],
  ['CL', '智利', 'Chile', ['es']],
  ['CO', '哥伦比亚', 'Colombia', ['es']],
  ['PE', '秘鲁', 'Peru', ['es']],
  ['VE', '委内瑞拉', 'Venezuela', ['es']],
  ['UY', '乌拉圭', 'Uruguay', ['es']],
  ['EC', '厄瓜多尔', 'Ecuador', ['es']],
  ['BO', '玻利维亚', 'Bolivia', ['es']],
  ['PY', '巴拉圭', 'Paraguay', ['es']],
  ['CU', '古巴', 'Cuba', ['es']],
  ['DO', '多米尼加', 'Dominican Republic', ['es']],
  ['GT', '危地马拉', 'Guatemala', ['es']],
  ['CR', '哥斯达黎加', 'Costa Rica', ['es']],
  ['GB', '英国', 'United Kingdom', ['en']],
  ['IE', '爱尔兰', 'Ireland', ['en']],
  ['FR', '法国', 'France', ['fr']],
  ['DE', '德国', 'Germany', ['de']],
  ['AT', '奥地利', 'Austria', ['de']],
  ['CH', '瑞士', 'Switzerland', ['de', 'fr', 'it']],
  ['NL', '荷兰', 'Netherlands', ['nl']],
  ['BE', '比利时', 'Belgium', ['nl', 'fr']],
  ['LU', '卢森堡', 'Luxembourg', ['fr', 'de']],
  ['ES', '西班牙', 'Spain', ['es']],
  ['PT', '葡萄牙', 'Portugal', ['pt']],
  ['IT', '意大利', 'Italy', ['it']],
  ['MT', '马耳他', 'Malta', ['mt', 'en']],
  ['GR', '希腊', 'Greece', ['el']],
  ['CY', '塞浦路斯', 'Cyprus', ['el', 'tr']],
  ['PL', '波兰', 'Poland', ['pl']],
  ['CZ', '捷克', 'Czechia', ['cs']],
  ['SK', '斯洛伐克', 'Slovakia', ['sk']],
  ['HU', '匈牙利', 'Hungary', ['hu']],
  ['RO', '罗马尼亚', 'Romania', ['ro']],
  ['BG', '保加利亚', 'Bulgaria', ['bg']],
  ['HR', '克罗地亚', 'Croatia', ['hr']],
  ['SI', '斯洛文尼亚', 'Slovenia', ['sl']],
  ['RS', '塞尔维亚', 'Serbia', ['sr']],
  ['BA', '波黑', 'Bosnia and Herzegovina', ['bs']],
  ['ME', '黑山', 'Montenegro', ['sr']],
  ['MK', '北马其顿', 'North Macedonia', ['mk']],
  ['AL', '阿尔巴尼亚', 'Albania', ['sq']],
  ['EE', '爱沙尼亚', 'Estonia', ['et']],
  ['LV', '拉脱维亚', 'Latvia', ['lv']],
  ['LT', '立陶宛', 'Lithuania', ['lt']],
  ['SE', '瑞典', 'Sweden', ['sv']],
  ['NO', '挪威', 'Norway', ['no']],
  ['DK', '丹麦', 'Denmark', ['da']],
  ['FI', '芬兰', 'Finland', ['fi']],
  ['IS', '冰岛', 'Iceland', ['is']],
  ['RU', '俄罗斯', 'Russia', ['ru']],
  ['BY', '白俄罗斯', 'Belarus', ['ru', 'be']],
  ['UA', '乌克兰', 'Ukraine', ['uk']],
  ['MD', '摩尔多瓦', 'Moldova', ['ro']],
  ['GE', '格鲁吉亚', 'Georgia', ['ka']],
  ['AM', '亚美尼亚', 'Armenia', ['hy']],
  ['AZ', '阿塞拜疆', 'Azerbaijan', ['az']],
  ['KZ', '哈萨克斯坦', 'Kazakhstan', ['kk', 'ru']],
  ['UZ', '乌兹别克斯坦', 'Uzbekistan', ['uz']],
  ['TR', '土耳其', 'Turkey', ['tr']],
  ['IR', '伊朗', 'Iran', ['fa']],
  ['IQ', '伊拉克', 'Iraq', ['ar']],
  ['IL', '以色列', 'Israel', ['he']],
  ['SA', '沙特阿拉伯', 'Saudi Arabia', ['ar']],
  ['AE', '阿联酋', 'United Arab Emirates', ['ar']],
  ['QA', '卡塔尔', 'Qatar', ['ar']],
  ['KW', '科威特', 'Kuwait', ['ar']],
  ['BH', '巴林', 'Bahrain', ['ar']],
  ['OM', '阿曼', 'Oman', ['ar']],
  ['JO', '约旦', 'Jordan', ['ar']],
  ['LB', '黎巴嫩', 'Lebanon', ['ar']],
  ['SY', '叙利亚', 'Syria', ['ar']],
  ['PS', '巴勒斯坦', 'Palestine', ['ar']],
  ['EG', '埃及', 'Egypt', ['ar']],
  ['MA', '摩洛哥', 'Morocco', ['ar']],
  ['DZ', '阿尔及利亚', 'Algeria', ['ar']],
  ['TN', '突尼斯', 'Tunisia', ['ar']],
  ['LY', '利比亚', 'Libya', ['ar']],
  ['SD', '苏丹', 'Sudan', ['ar']],
  ['ZA', '南非', 'South Africa', ['en', 'af']],
  ['NG', '尼日利亚', 'Nigeria', ['en']],
  ['KE', '肯尼亚', 'Kenya', ['sw', 'en']],
  ['GH', '加纳', 'Ghana', ['en']],
  ['ET', '埃塞俄比亚', 'Ethiopia', ['am']],
  ['TZ', '坦桑尼亚', 'Tanzania', ['sw']],
  ['UG', '乌干达', 'Uganda', ['en', 'sw']],
  ['SN', '塞内加尔', 'Senegal', ['fr']],
  ['CI', '科特迪瓦', 'Ivory Coast', ['fr']],
  ['CM', '喀麦隆', 'Cameroon', ['fr', 'en']],
  ['AO', '安哥拉', 'Angola', ['pt']],
  ['MZ', '莫桑比克', 'Mozambique', ['pt']],
  ['ZW', '津巴布韦', 'Zimbabwe', ['en']],
];

/** Common broadcasting languages, keyed by Radio Browser's ISO 639-1 codes. */
const LANGUAGE_TABLE = [
  ['zh', '中文', 'Chinese'],
  ['yue', '粤语', 'Cantonese'],
  ['ja', '日语', 'Japanese'],
  ['ko', '韩语', 'Korean'],
  ['hi', '印地语', 'Hindi'],
  ['ur', '乌尔都语', 'Urdu'],
  ['bn', '孟加拉语', 'Bengali'],
  ['ta', '泰米尔语', 'Tamil'],
  ['te', '泰卢固语', 'Telugu'],
  ['id', '印尼语', 'Indonesian'],
  ['ms', '马来语', 'Malay'],
  ['th', '泰语', 'Thai'],
  ['vi', '越南语', 'Vietnamese'],
  ['tl', '菲律宾语', 'Filipino'],
  ['en', '英语', 'English'],
  ['es', '西班牙语', 'Spanish'],
  ['pt', '葡萄牙语', 'Portuguese'],
  ['fr', '法语', 'French'],
  ['de', '德语', 'German'],
  ['it', '意大利语', 'Italian'],
  ['nl', '荷兰语', 'Dutch'],
  ['sv', '瑞典语', 'Swedish'],
  ['no', '挪威语', 'Norwegian'],
  ['nb', '挪威语', 'Norwegian'],
  ['da', '丹麦语', 'Danish'],
  ['fi', '芬兰语', 'Finnish'],
  ['is', '冰岛语', 'Icelandic'],
  ['et', '爱沙尼亚语', 'Estonian'],
  ['lv', '拉脱维亚语', 'Latvian'],
  ['lt', '立陶宛语', 'Lithuanian'],
  ['pl', '波兰语', 'Polish'],
  ['cs', '捷克语', 'Czech'],
  ['sk', '斯洛伐克语', 'Slovak'],
  ['hu', '匈牙利语', 'Hungarian'],
  ['ro', '罗马尼亚语', 'Romanian'],
  ['bg', '保加利亚语', 'Bulgarian'],
  ['hr', '克罗地亚语', 'Croatian'],
  ['sr', '塞尔维亚语', 'Serbian'],
  ['sl', '斯洛文尼亚语', 'Slovenian'],
  ['bs', '波斯尼亚语', 'Bosnian'],
  ['mk', '马其顿语', 'Macedonian'],
  ['sq', '阿尔巴尼亚语', 'Albanian'],
  ['el', '希腊语', 'Greek'],
  ['ru', '俄语', 'Russian'],
  ['uk', '乌克兰语', 'Ukrainian'],
  ['be', '白俄罗斯语', 'Belarusian'],
  ['ka', '格鲁吉亚语', 'Georgian'],
  ['hy', '亚美尼亚语', 'Armenian'],
  ['az', '阿塞拜疆语', 'Azerbaijani'],
  ['kk', '哈萨克语', 'Kazakh'],
  ['uz', '乌兹别克语', 'Uzbek'],
  ['tr', '土耳其语', 'Turkish'],
  ['fa', '波斯语', 'Persian'],
  ['ar', '阿拉伯语', 'Arabic'],
  ['he', '希伯来语', 'Hebrew'],
  ['sw', '斯瓦希里语', 'Swahili'],
  ['am', '阿姆哈拉语', 'Amharic'],
  ['af', '南非荷兰语', 'Afrikaans'],
  ['ca', '加泰罗尼亚语', 'Catalan'],
  ['eu', '巴斯克语', 'Basque'],
  ['gl', '加利西亚语', 'Galician'],
  ['ga', '爱尔兰语', 'Irish'],
  ['cy', '威尔士语', 'Welsh'],
  ['la', '拉丁语', 'Latin'],
  ['eo', '世界语', 'Esperanto'],
  ['mul', '多语言', 'Multilingual'],
];

const COUNTRY_BY_CODE = new Map();
const REGION_CODES = new Map();
// `new Map(rows)` would take each three-column row as [key, value] and keep
// only the Chinese name, so `known[1]` then read the second character of a
// string. Index the table explicitly instead.
const LANGUAGE_BY_CODE = new Map(LANGUAGE_TABLE.map(([code, zh, en]) => [code, { zh, en }]));

for (const [code, zh, en, languages] of COUNTRY_TABLE) {
  COUNTRY_BY_CODE.set(code, { zh, en });
  for (const language of languages || []) {
    if (!REGION_CODES.has(language)) REGION_CODES.set(language, []);
    REGION_CODES.get(language).push(code);
  }
}

const displayNames = (() => {
  if (typeof Intl === 'undefined' || typeof Intl.DisplayNames !== 'function') return null;
  try {
    return {
      zh: new Intl.DisplayNames(['zh-Hans'], { type: 'region', fallback: 'code' }),
      en: new Intl.DisplayNames(['en'], { type: 'region', fallback: 'code' }),
      langZh: new Intl.DisplayNames(['zh-Hans'], { type: 'language', fallback: 'code' }),
    };
  } catch {
    return null;
  }
})();

function intlName(formatter, code) {
  if (!formatter) return '';
  try {
    const value = formatter.of(code);
    return value && value !== code ? String(value) : '';
  } catch {
    return '';
  }
}

/**
 * Two-language name for a country code.
 * @returns {{zh: string, en: string}} never empty unless the code is empty.
 */
export function countryName(code) {
  const key = String(code || '').trim().toUpperCase();
  if (key.length === 0) return { zh: '地区未知', en: 'Unknown region' };
  const known = COUNTRY_BY_CODE.get(key);
  if (known) return { zh: known.zh, en: known.en };
  const zh = intlName(displayNames && displayNames.zh, key);
  const en = intlName(displayNames && displayNames.en, key);
  return { zh: zh || en || key, en: en || zh || key };
}

/** Two-language name for a language code. */
export function languageName(code) {
  const key = String(code || '').trim().toLowerCase();
  if (key.length === 0) return { zh: '语言未标注', en: 'Unspecified' };
  const known = LANGUAGE_BY_CODE.get(key);
  if (known) return { zh: known.zh, en: known.en };
  const zh = intlName(displayNames && displayNames.langZh, key);
  const en = intlName(displayNames && displayNames.en, key) || intlName(displayNames && displayNames.langZh, key);
  return { zh: zh || en || key, en: en || zh || key };
}

/**
 * A country code for records that only carry a broadcaster language.
 * Deterministic: the first region in the table that names this language.
 */
export function regionForLanguage(code) {
  const key = String(code || '').trim().toLowerCase();
  const regions = REGION_CODES.get(key);
  return regions && regions.length > 0 ? regions[0] : '';
}
