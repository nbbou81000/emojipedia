/**
 * build-index.mjs — script "one-shot" : construit le pool complet d'emojis.
 *
 * Produit :
 *   data/emoji-index.json   — un objet par emoji (noms FR/EN, mots-cles, categorie, version, stats)
 *   assets/emoji/<HEX>.svg  — le trace noir OpenMoji, minifie, pret pour l'e-ink
 *
 * Sources :
 *   - Unicode emoji-test.txt (liste officielle, categories, version d'introduction)
 *   - CLDR annotations fr/en (noms localises + mots-cles)
 *   - OpenMoji "black" (SVG au trait, CC BY-SA 4.0)
 *
 * Aucune dependance npm. Node 20+.
 * Le zip OpenMoji est telecharge et decompresse par le workflow, dans ./openmoji-black/
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const OUT_DATA = "data";
const OUT_SVG = "assets/emoji";
const OM_DIR = "openmoji-black";

const EMOJI_TEST = "https://unicode.org/Public/emoji/latest/emoji-test.txt";
const CLDR = (kind, lang) =>
  `https://raw.githubusercontent.com/unicode-org/cldr/main/common/${kind}/${lang}.xml`;
const OM_RAW = (hex) =>
  `https://raw.githubusercontent.com/hfg-gmuend/openmoji/master/black/svg/${hex}.svg`;

/* Annee de sortie de chaque version d'emoji (UTS #51). */
const YEARS = {
  "0.6": 2010, "0.7": 2014, "1.0": 2015, "2.0": 2015, "3.0": 2016,
  "4.0": 2016, "5.0": 2017, "11.0": 2018, "12.0": 2019, "12.1": 2019,
  "13.0": 2020, "13.1": 2021, "14.0": 2021, "15.0": 2022, "15.1": 2023,
  "16.0": 2024, "17.0": 2025, "18.0": 2026,
};

/* Les 9 grandes categories Unicode, traduites une fois pour toutes. */
const GROUPS_FR = {
  "Smileys & Emotion": "Frimousses et emotions",
  "People & Body": "Personnes et corps",
  "Animals & Nature": "Animaux et nature",
  "Food & Drink": "Nourriture et boissons",
  "Travel & Places": "Voyages et lieux",
  "Activities": "Activites",
  "Objects": "Objets",
  "Symbols": "Symboles",
  "Flags": "Drapeaux",
  "Component": "Composants",
};

async function get(url) {
  const r = await fetch(url, { headers: { "user-agent": "trmnl-emoji-index" } });
  if (!r.ok) throw new Error(`${r.status} sur ${url}`);
  return r.text();
}

/* ---------- 1. Liste officielle Unicode ---------- */

function parseEmojiTest(txt) {
  const out = [];
  let group = null, subgroup = null, order = 0;
  for (const line of txt.split("\n")) {
    if (line.startsWith("# group:")) { group = line.slice(8).trim(); continue; }
    if (line.startsWith("# subgroup:")) { subgroup = line.slice(11).trim(); continue; }
    if (!line.trim() || line.startsWith("#")) continue;
    const semi = line.indexOf(";");
    if (semi < 0) continue;
    const cpsRaw = line.slice(0, semi);
    const rest = line.slice(semi + 1);
    /* attention : le commentaire contient l'emoji lui-meme, et #(U+0023) est un emoji.
       on ne coupe donc que sur le PREMIER # rencontre. */
    const hash = rest.indexOf("#");
    if (hash < 0) continue;
    const status = rest.slice(0, hash);
    const comment = rest.slice(hash + 1);
    if (status.trim() !== "fully-qualified") continue;
    const m = comment.match(/^\s*(\S+)\s+E(\d+\.\d+)\s+(.*)$/);
    if (!m) continue;
    const [, char, version, nameEn] = m;
    const hex = cpsRaw.trim().replace(/\s+/g, "-");
    out.push({
      hex,
      char,
      order: ++order,
      name_en: nameEn.trim(),
      group,
      group_fr: GROUPS_FR[group] || group,
      subgroup,
      version,
      year: YEARS[version] ?? null,
      codepoints: hex.split("-").length,
      zwj: hex.includes("200D"),
      skintone: /-1F3F[B-F]/.test(hex),
    });
  }
  return out;
}

/* ---------- 2. Noms et mots-cles localises (CLDR) ---------- */

function parseCldr(xml, into) {
  const re = /<annotation cp="([^"]*)"(\s+type="tts")?\s*>([\s\S]*?)<\/annotation>/g;
  let m;
  while ((m = re.exec(xml))) {
    const cp = decodeEntities(m[1]);
    const isName = Boolean(m[2]);
    const value = decodeEntities(m[3]).trim();
    const slot = (into[cp] ??= { name: null, keywords: [] });
    if (isName) slot.name = value;
    else slot.keywords = value.split("|").map((s) => s.trim()).filter(Boolean);
  }
  return into;
}

function decodeEntities(s) {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}

/* CLDR n'ecrit pas toujours le VS16 : on essaie plusieurs formes de la meme sequence. */
function lookup(map, char) {
  const tries = [char, char.replace(/\uFE0F/g, ""), char + "\uFE0F"];
  for (const t of tries) if (map[t]) return map[t];
  return null;
}

/* ---------- 3. SVG OpenMoji ---------- */

function minifySvg(svg) {
  return svg
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s*\n\s*/g, "")
    .replace(/>\s+</g, "><")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function svgCandidates(hex) {
  return [hex, hex.replace(/-FE0F/g, ""), hex.replace(/FE0F-/g, "")];
}

/* ---------- Programme principal ---------- */

async function main() {
  console.log("1/4  Liste officielle Unicode...");
  const emojis = parseEmojiTest(await get(EMOJI_TEST));
  console.log(`     ${emojis.length} emojis entierement qualifies`);

  console.log("2/4  Noms et mots-cles CLDR (fr + en)...");
  const fr = {}, en = {};
  for (const kind of ["annotations", "annotationsDerived"]) {
    parseCldr(await get(CLDR(kind, "fr")), fr);
    parseCldr(await get(CLDR(kind, "en")), en);
  }

  console.log("3/4  Traces OpenMoji noirs...");
  await mkdir(OUT_SVG, { recursive: true });
  const available = new Set(
    existsSync(OM_DIR) ? (await readdir(OM_DIR)).filter((f) => f.endsWith(".svg")).map((f) => f.slice(0, -4)) : []
  );
  console.log(`     ${available.size} fichiers dans le zip OpenMoji`);

  let fromZip = 0, fromWeb = 0, noSvg = 0;
  for (const e of emojis) {
    const hit = svgCandidates(e.hex).find((h) => available.has(h));
    let svg = null;
    if (hit) {
      svg = await readFile(path.join(OM_DIR, `${hit}.svg`), "utf8");
      fromZip++;
    } else {
      for (const h of svgCandidates(e.hex)) {
        try { svg = await get(OM_RAW(h)); fromWeb++; break; } catch { /* suivant */ }
      }
    }
    if (!svg) { e.svg = false; noSvg++; continue; }
    await writeFile(path.join(OUT_SVG, `${e.hex}.svg`), minifySvg(svg));
    e.svg = true;
  }
  console.log(`     ${fromZip} depuis le zip, ${fromWeb} recuperes en ligne, ${noSvg} sans trace`);

  console.log("4/4  Ecriture de l'index...");
  const byGroup = {}, bySubgroup = {};
  for (const e of emojis) {
    byGroup[e.group] = (byGroup[e.group] || 0) + 1;
    bySubgroup[e.subgroup] = (bySubgroup[e.subgroup] || 0) + 1;
  }
  const rankInGroup = {}, rankInSub = {};

  const entries = emojis.map((e) => {
    const f = lookup(fr, e.char), a = lookup(en, e.char);
    rankInGroup[e.group] = (rankInGroup[e.group] || 0) + 1;
    rankInSub[e.subgroup] = (rankInSub[e.subgroup] || 0) + 1;
    return {
      hex: e.hex,
      char: e.char,
      order: e.order,
      svg: e.svg,
      name_fr: f?.name || null,
      name_en: a?.name || e.name_en,
      keywords_fr: f?.keywords || [],
      keywords_en: a?.keywords || [],
      group: e.group,
      group_fr: e.group_fr,
      subgroup: e.subgroup,
      version: e.version,
      year: e.year,
      codepoints: e.codepoints,
      zwj: e.zwj,
      skintone: e.skintone,
      stats: {
        rank_in_group: rankInGroup[e.group],
        group_size: byGroup[e.group],
        rank_in_subgroup: rankInSub[e.subgroup],
        subgroup_size: bySubgroup[e.subgroup],
        keywords_fr_count: (f?.keywords || []).length,
        keywords_en_count: (a?.keywords || []).length,
      },
    };
  });

  await mkdir(OUT_DATA, { recursive: true });
  const index = {
    generated_at: new Date().toISOString(),
    sources: {
      unicode: EMOJI_TEST,
      cldr: "unicode-org/cldr common/annotations + annotationsDerived (fr, en)",
      artwork: "OpenMoji black — CC BY-SA 4.0 — https://openmoji.org",
    },
    counts: {
      total: entries.length,
      with_svg: entries.filter((e) => e.svg).length,
      without_name_fr: entries.filter((e) => !e.name_fr).length,
      by_group: byGroup,
      by_version: entries.reduce((a, e) => ((a[e.version] = (a[e.version] || 0) + 1), a), {}),
    },
    emojis: entries,
  };
  await writeFile(path.join(OUT_DATA, "emoji-index.json"), JSON.stringify(index));

  console.log(`\nTermine : ${entries.length} emojis, ${index.counts.with_svg} traces, ` +
    `${index.counts.without_name_fr} sans nom francais.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
