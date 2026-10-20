/**
 * Concrete, picturable characters with a plain-English gloss, used for the last listening clue.
 * The server decides which character of the answer is concrete and what it means; the model only
 * phrases it, so it cannot invent a number or a colour that is not in the term.
 */

export type LiteralCategory = "number" | "body" | "colour" | "animal" | "person" | "nature" | "object" | "direction";

export interface LiteralHint {
  index: number;
  char: string;
  category: LiteralCategory;
  english: string;
}

const DICT: Record<LiteralCategory, Record<string, string>> = {
  number: { 零: "zero", 一: "one", 兩: "two", 二: "two", 三: "three", 四: "four", 五: "five", 六: "six", 七: "seven", 八: "eight", 九: "nine", 十: "ten", 百: "a hundred", 千: "a thousand", 萬: "ten thousand", 半: "half", 雙: "a pair" },
  body: { 手: "hand", 足: "foot", 腳: "foot", 口: "mouth", 耳: "ear", 目: "eye", 眼: "eye", 心: "heart", 頭: "head", 首: "head", 面: "face", 眉: "eyebrow", 舌: "tongue", 齒: "tooth", 牙: "tooth", 髮: "hair", 骨: "bone", 血: "blood", 肉: "flesh", 背: "back", 腹: "belly", 肝: "liver", 膽: "gallbladder", 臂: "arm", 指: "finger", 身: "body" },
  colour: { 紅: "red", 黃: "yellow", 青: "green", 綠: "green", 白: "white", 黑: "black", 紫: "purple", 金: "gold", 銀: "silver", 灰: "grey", 丹: "red" },
  animal: { 虎: "tiger", 龍: "dragon", 馬: "horse", 牛: "cow", 羊: "sheep", 雞: "chicken", 狗: "dog", 犬: "dog", 兔: "rabbit", 蛇: "snake", 蛙: "frog", 魚: "fish", 鳥: "bird", 狐: "fox", 鼠: "mouse", 猴: "monkey", 豬: "pig", 象: "elephant", 獅: "lion", 鶴: "crane", 鵰: "eagle", 鷹: "hawk", 燕: "swallow", 鳳: "phoenix", 鴨: "duck", 鵝: "goose", 蟲: "insect", 蟻: "ant", 蜂: "bee", 蝶: "butterfly", 螳: "mantis", 狼: "wolf", 鹿: "deer", 鯨: "whale", 龜: "turtle", 蚌: "clam", 鷸: "sandpiper", 雀: "sparrow", 鴉: "crow" },
  person: { 人: "person", 王: "king", 公: "old man", 翁: "old man", 子: "child", 君: "gentleman", 臣: "minister", 母: "mother", 父: "father", 友: "friend", 兄: "older brother", 弟: "younger brother", 夫: "husband", 妻: "wife", 女: "woman", 男: "man", 民: "people", 師: "teacher", 客: "guest", 主: "host", 將: "general", 兵: "soldier", 賊: "thief", 僧: "monk", 仙: "immortal", 鬼: "ghost", 神: "god" },
  nature: { 山: "mountain", 水: "water", 天: "sky", 地: "ground", 風: "wind", 雨: "rain", 火: "fire", 木: "tree", 樹: "tree", 石: "stone", 花: "flower", 月: "moon", 日: "sun", 星: "star", 雲: "cloud", 雪: "snow", 冰: "ice", 海: "sea", 江: "river", 河: "river", 湖: "lake", 井: "well", 田: "field", 草: "grass", 林: "forest", 葉: "leaf", 根: "root", 果: "fruit", 苗: "seedling", 雷: "thunder", 電: "lightning", 光: "light", 影: "shadow", 煙: "smoke", 土: "soil", 泥: "mud", 沙: "sand", 玉: "jade", 鐵: "iron", 竹: "bamboo", 松: "pine", 桃: "peach", 梅: "plum", 柳: "willow" },
  object: { 刀: "knife", 劍: "sword", 箭: "arrow", 弓: "bow", 矛: "spear", 盾: "shield", 船: "boat", 舟: "boat", 車: "cart", 門: "door", 窗: "window", 牆: "wall", 橋: "bridge", 路: "road", 屋: "house", 家: "home", 樓: "building", 鏡: "mirror", 燈: "lamp", 鐘: "bell", 鈴: "bell", 鼓: "drum", 琴: "zither", 筆: "brush", 書: "book", 紙: "paper", 畫: "painting", 衣: "clothes", 鞋: "shoe", 帽: "hat", 杯: "cup", 碗: "bowl", 飯: "rice", 酒: "wine", 茶: "tea", 米: "rice", 錢: "money", 珠: "pearl", 針: "needle", 線: "thread", 網: "net", 籠: "cage", 旗: "flag", 鼎: "cauldron", 梯: "ladder", 柱: "pillar", 棋: "chess" },
  direction: { 東: "east", 西: "west", 南: "south", 北: "north", 上: "up", 下: "down", 左: "left", 右: "right", 前: "front", 後: "back", 中: "middle", 內: "inside", 外: "outside" },
};

const CATEGORY_ORDER: LiteralCategory[] = ["number", "animal", "body", "colour", "nature", "object", "person", "direction"];

export const CATEGORY_LABEL: Record<LiteralCategory, string> = {
  number: "a number",
  body: "a body part",
  colour: "a colour",
  animal: "an animal",
  person: "a kind of person",
  nature: "something in nature",
  object: "an everyday object",
  direction: "a direction or position",
};

/** Every concrete character in the term, in character order. */
export function literalHints(term: string): LiteralHint[] {
  const out: LiteralHint[] = [];
  Array.from(term).forEach((char, index) => {
    for (const category of CATEGORY_ORDER) {
      const english = DICT[category][char];
      if (english) { out.push({ index, char, category, english }); break; }
    }
  });
  return out;
}

/** The numbers present in the term (so the prompt can state plainly that there are none). */
export function numbersIn(term: string): string[] {
  return Array.from(term).filter((c) => DICT.number[c]);
}

/**
 * Choose the literal hint for the last clue. Prefers a position the player has not been shown
 * (so the spoken hint and the revealed tile are two different hints), most concrete category first.
 */
export function pickLiteralHint(term: string, excludePositions: number[] = []): LiteralHint | null {
  const all = literalHints(term);
  if (!all.length) return null;
  const rank = (h: LiteralHint) => CATEGORY_ORDER.indexOf(h.category);
  const fresh = all.filter((h) => !excludePositions.includes(h.index)).sort((a, b) => rank(a) - rank(b));
  return fresh[0] ?? all.sort((a, b) => rank(a) - rank(b))[0];
}
