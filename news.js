// News module: polls RSS/Atom feeds, finds a place name in each headline,
// and broadcasts located items. No API keys, no dependencies.
import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_FEEDS = [
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml' },
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml' },
  { name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml' },
  { name: 'Yonhap', url: 'https://en.yna.co.kr/RSS/news.xml' },
  { name: '연합뉴스 국제', url: 'https://www.yna.co.kr/rss/international.xml' },
  { name: '연합뉴스 북한', url: 'https://www.yna.co.kr/rss/northkorea.xml' },
  { name: '구글뉴스 속보', url: 'https://news.google.com/rss/search?q=%EC%86%8D%EB%B3%B4&hl=ko&gl=KR&ceid=KR:ko' }
];

// [korean names | ..., english names | ..., lat, lng, kind]
// Cities come first so a city beats its country when both appear.
const PLACES = [
  ['서울', 'Seoul', 37.57, 126.98, 'city'], ['부산', 'Busan', 35.18, 129.08, 'city'], ['인천', 'Incheon', 37.46, 126.71, 'city'], ['대구', 'Daegu', 35.87, 128.6, 'city'], ['광주', 'Gwangju', 35.16, 126.85, 'city'], ['대전', 'Daejeon', 36.35, 127.38, 'city'], ['제주', 'Jeju', 33.5, 126.53, 'city'], ['판문점', 'Panmunjom', 37.96, 126.68, 'city'], ['개성', 'Kaesong', 37.97, 126.55, 'city'],
  ['평양', 'Pyongyang', 39.03, 125.75, 'city'], ['신포', 'Sinpo', 40.03, 128.18, 'city'], ['영변', 'Yongbyon', 39.8, 125.75, 'city'],
  ['도쿄', 'Tokyo', 35.68, 139.69, 'city'], ['오사카', 'Osaka', 34.69, 135.5, 'city'], ['후쿠오카', 'Fukuoka', 33.59, 130.4, 'city'], ['삿포로', 'Sapporo', 43.06, 141.35, 'city'], ['오키나와', 'Okinawa', 26.33, 127.8, 'city'], ['후쿠시마', 'Fukushima', 37.75, 140.47, 'city'], ['나고야', 'Nagoya', 35.18, 136.91, 'city'], ['교토', 'Kyoto', 35.01, 135.77, 'city'], ['홋카이도', 'Hokkaido', 43.2, 142.8, 'city'], ['노토', 'Noto', 37.3, 136.9, 'city'],
  ['베이징|북경', 'Beijing', 39.9, 116.4, 'city'], ['상하이', 'Shanghai', 31.23, 121.47, 'city'], ['홍콩', 'Hong Kong', 22.32, 114.17, 'city'], ['!선전', 'Shenzhen', 22.54, 114.06, 'city'], ['광저우', 'Guangzhou', 23.13, 113.26, 'city'], ['우한', 'Wuhan', 30.59, 114.31, 'city'], ['!신장', 'Xinjiang', 41.1, 85.2, 'city'], ['티베트', 'Tibet', 31.0, 88.0, 'city'], ['마카오', 'Macau', 22.2, 113.55, 'city'],
  ['타이베이', 'Taipei', 25.03, 121.57, 'city'], ['화롄', 'Hualien', 23.99, 121.6, 'city'], ['진먼', 'Kinmen', 24.44, 118.38, 'city'],
  ['모스크바', 'Moscow', 55.76, 37.62, 'city'], ['상트페테르부르크', 'St Petersburg|Saint Petersburg', 59.93, 30.34, 'city'], ['블라디보스토크', 'Vladivostok', 43.12, 131.89, 'city'], ['쿠르스크', 'Kursk', 51.73, 36.19, 'city'], ['벨고로드', 'Belgorod', 50.6, 36.59, 'city'], ['크림반도|크림', 'Crimea', 45.0, 34.1, 'city'], ['세바스토폴', 'Sevastopol', 44.6, 33.52, 'city'],
  ['키이우|키예프', 'Kyiv|Kiev', 50.45, 30.52, 'city'], ['하르키우', 'Kharkiv', 49.99, 36.23, 'city'], ['오데사', 'Odesa|Odessa', 46.48, 30.72, 'city'], ['자포리자', 'Zaporizhzhia', 47.84, 35.14, 'city'], ['도네츠크', 'Donetsk', 48.0, 37.8, 'city'], ['헤르손', 'Kherson', 46.64, 32.62, 'city'], ['드니프로', 'Dnipro', 48.46, 35.05, 'city'], ['리비우', 'Lviv', 49.84, 24.03, 'city'], ['돈바스', 'Donbas', 48.3, 38.0, 'city'], ['포크로우스크', 'Pokrovsk', 48.28, 37.18, 'city'],
  ['가자지구', 'Gaza', 31.42, 34.37, 'city'], ['라파', 'Rafah', 31.29, 34.25, 'city'], ['칸유니스', 'Khan Younis', 31.35, 34.31, 'city'], ['요르단강 서안|서안지구', 'West Bank', 31.95, 35.3, 'city'], ['예루살렘', 'Jerusalem', 31.77, 35.21, 'city'], ['텔아비브', 'Tel Aviv', 32.09, 34.78, 'city'], ['베이루트', 'Beirut', 33.89, 35.5, 'city'], ['다마스쿠스', 'Damascus', 33.51, 36.29, 'city'], ['알레포', 'Aleppo', 36.2, 37.13, 'city'], ['테헤란', 'Tehran', 35.69, 51.39, 'city'], ['바그다드', 'Baghdad', 33.31, 44.36, 'city'], ['!사나', "Sanaa|Sana'a", 15.37, 44.19, 'city'], ['호데이다', 'Hodeidah', 14.8, 42.95, 'city'], ['리야드', 'Riyadh', 24.71, 46.68, 'city'], ['두바이', 'Dubai', 25.2, 55.27, 'city'], ['도하', 'Doha', 25.29, 51.53, 'city'], ['앙카라', 'Ankara', 39.93, 32.86, 'city'], ['이스탄불', 'Istanbul', 41.01, 28.98, 'city'], ['카이로', 'Cairo', 30.04, 31.24, 'city'], ['홍해', 'Red Sea', 20.0, 38.5, 'city'], ['호르무즈', 'Hormuz', 26.57, 56.25, 'city'],
  ['카불', 'Kabul', 34.56, 69.21, 'city'], ['이슬라마바드', 'Islamabad', 33.68, 73.05, 'city'], ['카라치', 'Karachi', 24.86, 67.0, 'city'], ['뉴델리|델리', 'New Delhi|Delhi', 28.61, 77.21, 'city'], ['뭄바이', 'Mumbai', 19.08, 72.88, 'city'], ['카슈미르', 'Kashmir', 34.08, 74.8, 'city'], ['다카', 'Dhaka', 23.81, 90.41, 'city'], ['카트만두', 'Kathmandu', 27.72, 85.32, 'city'], ['콜롬보', 'Colombo', 6.93, 79.86, 'city'],
  ['방콕', 'Bangkok', 13.76, 100.5, 'city'], ['하노이', 'Hanoi', 21.03, 105.85, 'city'], ['호찌민|호치민', 'Ho Chi Minh City', 10.82, 106.63, 'city'], ['마닐라', 'Manila', 14.6, 120.98, 'city'], ['자카르타', 'Jakarta', -6.21, 106.85, 'city'], ['발리', 'Bali', -8.34, 115.09, 'city'], ['싱가포르', 'Singapore', 1.35, 103.82, 'city'], ['쿠알라룸푸르', 'Kuala Lumpur', 3.14, 101.69, 'city'], ['양곤', 'Yangon', 16.84, 96.17, 'city'], ['프놈펜', 'Phnom Penh', 11.56, 104.92, 'city'], ['남중국해', 'South China Sea', 12.0, 114.0, 'city'],
  ['시드니', 'Sydney', -33.87, 151.21, 'city'], ['멜버른', 'Melbourne', -37.81, 144.96, 'city'], ['오클랜드', 'Auckland', -36.85, 174.76, 'city'],
  ['런던', 'London', 51.51, -0.13, 'city'], ['파리', 'Paris', 48.86, 2.35, 'city'], ['베를린', 'Berlin', 52.52, 13.4, 'city'], ['브뤼셀', 'Brussels', 50.85, 4.35, 'city'], ['로마', 'Rome', 41.9, 12.5, 'city'], ['마드리드', 'Madrid', 40.42, -3.7, 'city'], ['바르셀로나', 'Barcelona', 41.39, 2.17, 'city'], ['암스테르담', 'Amsterdam', 52.37, 4.9, 'city'], ['헤이그', 'The Hague', 52.08, 4.3, 'city'], ['제네바', 'Geneva', 46.2, 6.14, 'city'], ['!빈', 'Vienna', 48.21, 16.37, 'city'], ['바르샤바', 'Warsaw', 52.23, 21.01, 'city'], ['아테네', 'Athens', 37.98, 23.73, 'city'], ['스톡홀름', 'Stockholm', 59.33, 18.07, 'city'], ['헬싱키', 'Helsinki', 60.17, 24.94, 'city'], ['민스크', 'Minsk', 53.9, 27.56, 'city'], ['바티칸', 'Vatican', 41.9, 12.45, 'city'],
  ['워싱턴', 'Washington|White House|Pentagon', 38.9, -77.04, 'city'], ['뉴욕', 'New York', 40.71, -74.0, 'city'], ['로스앤젤레스', 'Los Angeles', 34.05, -118.24, 'city'], ['샌프란시스코', 'San Francisco', 37.77, -122.42, 'city'], ['시카고', 'Chicago', 41.88, -87.63, 'city'], ['텍사스', 'Texas', 31.0, -99.0, 'city'], ['플로리다', 'Florida', 27.8, -81.7, 'city'], ['캘리포니아', 'California', 36.8, -119.4, 'city'], ['하와이', 'Hawaii', 20.8, -156.3, 'city'], ['알래스카', 'Alaska', 64.2, -149.5, 'city'], ['괌', 'Guam', 13.44, 144.79, 'city'], ['오타와', 'Ottawa', 45.42, -75.7, 'city'], ['토론토', 'Toronto', 43.65, -79.38, 'city'], ['밴쿠버', 'Vancouver', 49.28, -123.12, 'city'], ['멕시코시티', 'Mexico City', 19.43, -99.13, 'city'], ['아바나', 'Havana', 23.11, -82.37, 'city'], ['카라카스', 'Caracas', 10.48, -66.9, 'city'], ['보고타', 'Bogota|Bogotá', 4.71, -74.07, 'city'], ['리마', 'Lima', -12.05, -77.04, 'city'], ['산티아고', 'Santiago', -33.45, -70.67, 'city'], ['부에노스아이레스', 'Buenos Aires', -34.6, -58.38, 'city'], ['상파울루', 'Sao Paulo|São Paulo', -23.55, -46.63, 'city'], ['리우데자네이루', 'Rio de Janeiro', -22.91, -43.17, 'city'], ['포르토프랭스', 'Port-au-Prince', 18.59, -72.31, 'city'],
  ['하르툼', 'Khartoum', 15.5, 32.56, 'city'], ['다르푸르', 'Darfur', 13.5, 24.0, 'city'], ['나이로비', 'Nairobi', -1.29, 36.82, 'city'], ['아디스아바바', 'Addis Ababa', 9.03, 38.74, 'city'], ['라고스', 'Lagos', 6.52, 3.38, 'city'], ['킨샤사', 'Kinshasa', -4.44, 15.27, 'city'], ['!고마', 'Goma', -1.68, 29.22, 'city'], ['모가디슈', 'Mogadishu', 2.05, 45.32, 'city'], ['트리폴리', 'Tripoli', 32.89, 13.19, 'city'], ['요하네스버그', 'Johannesburg', -26.2, 28.05, 'city'], ['케이프타운', 'Cape Town', -33.92, 18.42, 'city'],

  ['북한|북측', 'North Korea|North Korean|DPRK', 40.0, 127.0, 'country'], ['한국|남한|대한민국', 'South Korea|South Korean', 36.5, 127.8, 'country'], ['일본', 'Japan|Japanese', 36.2, 138.3, 'country'], ['중국', 'China|Chinese', 35.0, 103.0, 'country'], ['대만', 'Taiwan|Taiwanese', 23.7, 121.0, 'country'], ['몽골', 'Mongolia', 46.9, 103.8, 'country'],
  ['러시아', 'Russia|Russian|Kremlin', 56.0, 38.0, 'country'], ['우크라이나', 'Ukraine|Ukrainian', 49.0, 31.4, 'country'], ['벨라루스', 'Belarus', 53.7, 28.0, 'country'],
  ['이스라엘', 'Israel|Israeli', 31.5, 34.9, 'country'], ['팔레스타인', 'Palestine|Palestinian', 31.9, 35.2, 'country'], ['레바논', 'Lebanon|Lebanese|Hezbollah', 33.9, 35.8, 'country'], ['시리아', 'Syria|Syrian', 35.0, 38.5, 'country'], ['이란', 'Iran|Iranian', 32.4, 53.7, 'country'], ['이라크', 'Iraq|Iraqi', 33.2, 43.7, 'country'], ['예멘', 'Yemen|Houthi|Houthis', 15.6, 48.5, 'country'], ['사우디아라비아|사우디', 'Saudi Arabia|Saudi', 23.9, 45.1, 'country'], ['아랍에미리트', 'United Arab Emirates|UAE', 23.4, 53.8, 'country'], ['카타르', 'Qatar', 25.35, 51.2, 'country'], ['요르단', 'Jordanian', 31.0, 36.0, 'country'], ['튀르키예|터키', 'Turkey|Türkiye|Turkish', 39.0, 35.2, 'country'], ['이집트', 'Egypt|Egyptian', 26.8, 30.8, 'country'], ['아프가니스탄', 'Afghanistan|Afghan|Taliban', 33.9, 67.7, 'country'], ['파키스탄', 'Pakistan|Pakistani', 30.4, 69.3, 'country'],
  ['인도', 'India|Indian', 21.0, 78.0, 'country'], ['방글라데시', 'Bangladesh', 23.7, 90.4, 'country'], ['네팔', 'Nepal', 28.4, 84.1, 'country'], ['스리랑카', 'Sri Lanka', 7.9, 80.8, 'country'], ['미얀마', 'Myanmar', 21.9, 95.96, 'country'], ['태국', 'Thailand|Thai', 15.9, 100.99, 'country'], ['베트남', 'Vietnam|Vietnamese', 14.1, 108.3, 'country'], ['필리핀', 'Philippines|Philippine|Filipino', 12.9, 121.8, 'country'], ['인도네시아', 'Indonesia|Indonesian', -0.8, 113.9, 'country'], ['말레이시아', 'Malaysia', 4.2, 102.0, 'country'], ['캄보디아', 'Cambodia', 12.6, 104.99, 'country'], ['라오스', 'Laos', 19.86, 102.5, 'country'],
  ['호주', 'Australia|Australian', -25.3, 133.8, 'country'], ['뉴질랜드', 'New Zealand', -40.9, 174.9, 'country'], ['파푸아뉴기니', 'Papua New Guinea', -6.3, 143.96, 'country'], ['바누아투', 'Vanuatu', -15.4, 166.96, 'country'], ['통가', 'Tonga', -21.18, -175.2, 'country'], ['!피지', 'Fiji', -17.7, 178.07, 'country'],
  ['영국', 'Britain|British|UK|United Kingdom', 52.4, -1.5, 'country'], ['프랑스', 'France|French', 46.6, 2.2, 'country'], ['독일', 'Germany|German', 51.2, 10.4, 'country'], ['이탈리아', 'Italy|Italian', 42.8, 12.6, 'country'], ['스페인', 'Spain|Spanish', 40.5, -3.7, 'country'], ['포르투갈', 'Portugal', 39.4, -8.2, 'country'], ['네덜란드', 'Netherlands|Dutch', 52.1, 5.3, 'country'], ['벨기에', 'Belgium', 50.5, 4.5, 'country'], ['스위스', 'Switzerland|Swiss', 46.8, 8.2, 'country'], ['오스트리아', 'Austria', 47.5, 14.6, 'country'], ['폴란드', 'Poland|Polish', 51.9, 19.1, 'country'], ['체코', 'Czech', 49.8, 15.5, 'country'], ['헝가리', 'Hungary|Hungarian', 47.2, 19.5, 'country'], ['루마니아', 'Romania', 45.9, 24.97, 'country'], ['세르비아', 'Serbia', 44.0, 21.0, 'country'], ['그리스', 'Greece|Greek', 39.1, 21.8, 'country'], ['스웨덴', 'Sweden|Swedish', 60.1, 18.6, 'country'], ['노르웨이', 'Norway|Norwegian', 60.5, 8.5, 'country'], ['핀란드', 'Finland|Finnish', 61.9, 25.7, 'country'], ['덴마크', 'Denmark|Danish', 56.3, 9.5, 'country'], ['그린란드', 'Greenland', 72.0, -40.0, 'country'], ['아이슬란드', 'Iceland', 64.96, -19.0, 'country'], ['아일랜드', 'Ireland|Irish', 53.4, -8.2, 'country'], ['조지아', 'Georgian', 42.3, 43.4, 'country'], ['아르메니아', 'Armenia', 40.07, 45.04, 'country'], ['아제르바이잔', 'Azerbaijan', 40.14, 47.58, 'country'], ['카자흐스탄', 'Kazakhstan', 48.0, 66.9, 'country'], ['몰도바', 'Moldova', 47.4, 28.4, 'country'],
  ['미국', 'United States|U.S.|US', 39.8, -98.6, 'country'], ['캐나다', 'Canada|Canadian', 56.1, -106.3, 'country'], ['멕시코', 'Mexico|Mexican', 23.6, -102.6, 'country'], ['쿠바', 'Cuba|Cuban', 21.5, -77.8, 'country'], ['아이티', 'Haiti|Haitian', 18.97, -72.3, 'country'], ['베네수엘라', 'Venezuela|Venezuelan', 6.4, -66.6, 'country'], ['콜롬비아', 'Colombia|Colombian', 4.6, -74.3, 'country'], ['에콰도르', 'Ecuador', -1.8, -78.2, 'country'], ['페루', 'Peru|Peruvian', -9.2, -75.0, 'country'], ['칠레', 'Chile|Chilean', -35.7, -71.5, 'country'], ['아르헨티나', 'Argentina|Argentine', -38.4, -63.6, 'country'], ['브라질', 'Brazil|Brazilian', -14.2, -51.9, 'country'], ['볼리비아', 'Bolivia', -16.3, -63.6, 'country'], ['파나마', 'Panama', 8.5, -80.8, 'country'], ['과테말라', 'Guatemala', 15.8, -90.2, 'country'], ['니카라과', 'Nicaragua', 12.9, -85.2, 'country'],
  ['!수단', 'Sudan|Sudanese', 12.9, 30.2, 'country'], ['남수단', 'South Sudan', 6.9, 31.3, 'country'], ['에티오피아', 'Ethiopia|Ethiopian', 9.1, 40.5, 'country'], ['소말리아', 'Somalia|Somali', 5.2, 46.2, 'country'], ['케냐', 'Kenya|Kenyan', -0.02, 37.9, 'country'], ['나이지리아', 'Nigeria|Nigerian', 9.1, 8.7, 'country'], ['콩고', 'Congo|DR Congo|DRC', -4.0, 21.8, 'country'], ['남아프리카공화국|남아공', 'South Africa|South African', -30.6, 22.9, 'country'], ['리비아', 'Libya|Libyan', 26.3, 17.2, 'country'], ['튀니지', 'Tunisia', 33.9, 9.5, 'country'], ['알제리', 'Algeria', 28.0, 1.7, 'country'], ['모로코', 'Morocco|Moroccan', 31.8, -7.1, 'country'], ['!말리', 'Mali', 17.6, -4.0, 'country'], ['니제르', 'Niger', 17.6, 8.1, 'country'], ['부르키나파소', 'Burkina Faso', 12.2, -1.6, 'country'], ['차드', 'Chadian', 15.5, 18.7, 'country'], ['르완다', 'Rwanda', -1.9, 29.9, 'country'], ['우간다', 'Uganda', 1.4, 32.3, 'country'], ['모잠비크', 'Mozambique', -18.7, 35.5, 'country'], ['짐바브웨', 'Zimbabwe', -19.0, 29.2, 'country'], ['마다가스카르', 'Madagascar', -18.8, 46.9, 'country'], ['!가나', 'Ghana', 7.9, -1.0, 'country']
];

const FLASH_EN = /\b(breaking|earthquake|quake|tsunami|explosions?|blasts?|missiles?|air ?strikes?|attacks?|shooting|gunman|killed|dead|deaths?|coup|evacuat\w*|eruption|volcano|hurricane|typhoon|cyclone|wildfires?|crash(es|ed)?|hostages?|invasion|invades?|nuclear|state of emergency|martial law|bombing|drone strike)\b/i;
const FLASH_KO = /(속보|긴급|지진|쓰나미|해일|폭발|미사일|공습|테러|총격|사망|숨져|숨진|쿠데타|대피|분화|태풍|산불|추락|침공|핵실험|비상계엄|계엄|발사|피격|폭격|인질)/;

const HANGUL = /[가-힣]/;
const KO_TAIL = new Set(['', '은', '는', '이', '가', '을', '를', '의', '에', '에서', '에서도', '에선', '에도', '도', '과', '와', '과의', '와의', '로', '으로', '로부터', '으로부터', '만', '까지', '서', '측', '군', '발', '산', '정부', '당국', '내', '인', '행', '전역', '서도', '에게', '판', '계', '시', '현', '주', '성', '반도', '섬', '항', '공항', '지역', '일대', '근해', '앞바다', '해역', '시내', '도심', '인근', '부근', '국경']);

function buildMatchers() {
  const list = [];
  PLACES.forEach(([ko, en, lat, lng, kind], order) => {
    // a leading "!" marks a Korean name that is also a common word (수단, 선전, 빈…): shown, never matched
    const place = { ko: ko.split('|')[0].replace(/^!/, ''), en: en.split('|')[0], lat, lng, kind, order };
    ko.split('|').filter(n => !n.startsWith('!')).forEach(n => list.push({ lang: 'ko', name: n, place }));
    en.split('|').forEach(n => list.push({ lang: 'en', name: n, place, re: new RegExp(`(^|[^A-Za-z])${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z])`) }));
  });
  // longer names first so "South Korea" wins over "Korea", "남수단" over "수단"
  return list.sort((a, b) => b.name.length - a.name.length);
}
const MATCHERS = buildMatchers();

function koFind(text, name) {
  let i = text.indexOf(name);
  while (i >= 0) {
    const before = text[i - 1];
    if (!before || !HANGUL.test(before)) {
      let j = i + name.length, tail = '';
      while (j < text.length && HANGUL.test(text[j])) tail += text[j++];
      if (KO_TAIL.has(tail)) return i;
    }
    i = text.indexOf(name, i + 1);
  }
  return -1;
}

// Find the best place in a text: a city beats a country, then the earliest mention wins.
export function locate(text) {
  if (!text) return null;
  const hits = [];
  const taken = [];
  for (const m of MATCHERS) {
    let idx;
    if (m.lang === 'ko') idx = koFind(text, m.name);
    else { const r = m.re.exec(text); idx = r ? r.index + r[1].length : -1; }
    if (idx < 0) continue;
    // skip a shorter name sitting inside a longer one already found ("수단" in "남수단")
    if (taken.some(([s, e]) => idx >= s && idx < e)) continue;
    taken.push([idx, idx + m.name.length]);
    hits.push({ ...m.place, idx });
  }
  if (!hits.length) return null;
  hits.sort((a, b) => (a.kind === b.kind ? a.idx - b.idx : a.kind === 'city' ? -1 : 1));
  const h = hits[0];
  return { ko: h.ko, en: h.en, lat: h.lat, lng: h.lng, kind: h.kind };
}

// ---------- RSS / Atom parsing ----------
function decode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&quot;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ').trim();
}
const tag = (block, name) => { const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i')); return m ? m[1] : ''; };

export function parseFeed(xml, feedName) {
  const out = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks) {
    // decode twice: some feeds escape HTML inside CDATA-less descriptions
    let title = decode(decode(tag(b, 'title')));
    let link = decode(tag(b, 'link'));
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"/i); link = m ? m[1].replace(/&amp;/g, '&') : ''; }
    const when = Date.parse(decode(tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')));
    const desc = decode(decode(tag(b, 'description') || tag(b, 'summary'))).slice(0, 400);
    let outlet = decode(tag(b, 'source')) || feedName;
    // Google News titles end with " - Outlet"
    if (/news\.google\./.test(link) || feedName.startsWith('구글')) {
      const k = title.lastIndexOf(' - ');
      if (k > 10) { outlet = title.slice(k + 3); title = title.slice(0, k); }
    }
    if (!title) continue;
    out.push({ title, link, time: isFinite(when) ? when : Date.now(), desc, outlet });
  }
  return out;
}

// ---------- polling ----------
const keyOf = t => t.toLowerCase().replace(/[^a-z0-9가-힣]/g, '').slice(0, 48);

export function createNews({ broadcast, status, log, UA, root, onItem = () => {} }) {
  let feeds = DEFAULT_FEEDS;
  try {
    const custom = JSON.parse(fs.readFileSync(path.join(root, 'feeds.json'), 'utf8')).feeds;
    if (Array.isArray(custom) && custom.length) feeds = custom.filter(f => f && f.url).map(f => ({ name: f.name || f.url, url: f.url }));
  } catch { /* no custom list */ }

  const items = [];              // newest first
  const seen = new Set();
  const firstDone = new Set();
  const feedState = {};

  async function fetchText(url) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': UA, Accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' } });
      if (!r.ok) throw new Error(`${r.status}`);
      return await r.text();
    } finally { clearTimeout(t); }
  }

  async function pollFeed(f) {
    try {
      const parsed = parseFeed(await fetchText(f.url), f.name);
      feedState[f.name] = 'ok';
      const cutoff = Date.now() - 36 * 3600e3;
      const fresh = [];
      for (const p of parsed) {
        const k = keyOf(p.title);
        if (!k || seen.has(k) || p.time < cutoff) continue;
        seen.add(k);
        const loc = locate(p.title) || locate(p.desc);
        if (!loc) continue;
        const flash = FLASH_EN.test(p.title) || FLASH_KO.test(p.title);
        const it = { id: 'n-' + k, type: 'news', ...p, place: loc.ko, placeEn: loc.en, lat: loc.lat, lng: loc.lng, scope: loc.kind, flash, feed: f.name };
        items.push(it);
        fresh.push(it);
      }
      items.sort((a, b) => b.time - a.time);
      items.splice(200);
      // first load fills the list quietly; after that only recent items are announced
      fresh.sort((a, b) => a.time - b.time).forEach(it => {
        const live = firstDone.has(f.name) && it.time > Date.now() - 3 * 3600e3;
        if (live) { log(`NEWS${it.flash ? ' (flash)' : ''}: [${it.place}] ${it.title}`); broadcast('news', it); }
        onItem(it, live);
      });
      firstDone.add(f.name);
    } catch (e) {
      feedState[f.name] = 'error';
      log(`news feed error (${f.name}):`, e.message);
    }
    const states = Object.values(feedState);
    status.news = states.includes('ok') ? 'ok' : states.length ? 'error' : 'wait';
  }

  function start(intervalMs = 180000) {
    status.news = 'wait';
    feeds.forEach((f, i) => {
      setTimeout(() => { pollFeed(f); setInterval(() => pollFeed(f), intervalMs); }, i * 4000);
    });
  }

  return { start, list: () => items, feeds: () => feeds.map(f => ({ name: f.name, state: feedState[f.name] || 'wait' })) };
}

// Gazetteer for the search box: every place with its names in both languages.
export function placeList() {
  return PLACES.map(([ko, en, lat, lng, kind]) => ({
    ko: ko.split('|')[0].replace(/^!/, ''), en: en.split('|')[0],
    names: [...ko.split('|').map(n => n.replace(/^!/, '')), ...en.split('|')], lat, lng, kind
  }));
}
