/**
 * 正規化 N(text)（docs/03 §2.6.1）
 *
 * 1. Unicode NFKC
 * 2. 制御文字を除く（改行・タブは空白として扱う）
 * 3. 連続する空白を1つの空白にする
 * 4. 前後の空白を除く
 *
 * 性質 P1：N は冪等（N(N(x)) === N(x)）
 */
export function normalize(text: string): string {
  const nfkc = text.normalize("NFKC");
  // 改行・タブなどの空白類を空白に、その他の制御文字（C0/C1、ゼロ幅など）を除く
  const noControl = nfkc
    .replace(/[\t\n\v\f\r\u{85}\u{2028}\u{2029}]/gu, " ")
    .replace(/[\u{0}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200d}\u{2060}\u{feff}]/gu, "");
  // NFKC 後に残りうる各種空白（U+3000 は NFKC で U+0020 になる）をまとめる
  const collapsed = noControl.replace(/[\s\u{a0}\u{1680}\u{2000}-\u{200a}\u{202f}\u{205f}\u{3000}]+/gu, " ");
  const trimmed = collapsed.trim();
  // NFKC は合成済みの文字列に対して冪等だが、除去・置換で隣り合った文字が
  // 再合成されうるので、もう一度 NFKC をかけて固定点にする
  const again = trimmed.normalize("NFKC");
  return again === trimmed ? trimmed : normalize(again);
}

/**
 * 記号・空白・幅の違いを無視して比べるための、より緩い形。
 * 照合の2段目（docs/03 §2.6.2）で使う。台帳には書かない。
 */
export function loosen(text: string): string {
  return loosenWithMap(normalize(text)).loose;
}

const IGNORABLE = /[\p{P}\p{S}\s]/u;

/**
 * 正規化済みの文字列 n から緩い形を作り、緩い形の各文字が n のどこから来たかを返す。
 * starts[i] / ends[i]：緩い形の i 文字目に対応する n 上の範囲 [starts[i], ends[i])。
 */
export function loosenWithMap(n: string): { loose: string; starts: number[]; ends: number[] } {
  let loose = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of n) {
    const len = ch.length;
    if (!IGNORABLE.test(ch)) {
      const lower = ch.toLowerCase();
      for (let k = 0; k < lower.length; k++) {
        starts.push(i);
        ends.push(i + len);
      }
      loose += lower;
    }
    i += len;
  }
  return { loose, starts, ends };
}
