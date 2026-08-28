import { randomBytes } from "node:crypto";

const moods = [
  "자유로운", "용감한", "느긋한", "다정한", "재빠른", "씩씩한", "반짝이는", "고요한",
  "행복한", "장난스러운", "푸른", "든든한", "엉뚱한", "수상한", "졸린", "신나는",
  "야무진", "낭만적인", "배고픈", "침착한", "유쾌한", "뽀송한", "부지런한", "당당한",
  "새침한", "포근한", "호기심 많은", "노래하는", "춤추는", "구름 같은", "바람 빠른", "웃음 많은",
];
const animals = [
  "기린", "호랑이", "수달", "다람쥐", "두루미", "반달곰", "고라니", "까치",
  "토끼", "너구리", "삵", "돌고래", "오소리", "해달", "쿼카", "알파카",
  "펭귄", "라쿤", "카피바라", "참새", "부엉이", "문어", "복어", "해마",
  "청설모", "진돗개", "오리", "두더지", "미어캣", "판다", "코끼리", "치타",
];
const foods = [
  "김치냉장고", "떡볶이", "붕어빵", "호떡", "삼각김밥", "라면", "김밥", "군고구마",
  "달고나", "약과", "냉면", "비빔밥", "만두", "파전", "초코우유", "식혜",
  "치킨무", "계란빵", "수박화채", "쫀드기", "컵밥", "어묵 국물", "참기름", "누룽지",
];
const places = [
  "한강", "남산", "광화문", "제주 바다", "동네 편의점", "찜질방", "노래방", "장독대 옆",
  "옥상 텃밭", "막차 안", "버스 종점", "학교 운동장", "재래시장", "골목길", "지하철역", "동네 공원",
  "빨래방", "분식집 앞", "PC방", "산책로", "해수욕장", "도서관", "논두렁", "구름 위",
];
const challenges = [
  "월요일", "막차", "알람 다섯 개", "소나기", "급식 줄", "퇴근길 정체", "와이파이 한 칸", "매운맛 5단계",
  "새벽 배송", "엘리베이터 점검", "체육 시간", "눈치 게임", "가위바위보", "장마철", "겨울 이불", "점심 졸음",
  "회전문", "긴 신호등", "뜨거운 어묵", "마지막 한 입", "비 오는 출근길", "보조배터리 1퍼센트", "숙제 마감", "잔액 부족",
];
const times = [
  "새벽 세 시", "첫차 시간", "점심 직전", "퇴근 오 분 전", "일요일 저녁", "월요일 아침", "눈 오는 밤", "비 오는 오후",
  "해 뜨기 직전", "막차 출발 전", "간식 시간", "체육 시간", "자정", "낮잠 직후", "알람 울리기 전", "치킨 도착 순간",
];
const rides = [
  "킥보드", "장바구니", "구름", "붕어빵 봉투", "택배 상자", "회전의자", "고무대야", "돗자리",
  "세발자전거", "쇼핑카트", "종이비행기", "노란 버스", "오리배", "눈썰매", "청소기", "김치통",
];
const roles = [
  "골대 철학자", "동네 대장", "막차 안내원", "간식 수호자", "분식집 단골", "구름 감별사", "라면 연구원", "낮잠 전문가",
  "골목 탐험가", "월요일 해결사", "와이파이 기사", "붕어빵 심사위원", "비밀 요원", "박수 장인", "응원 단장", "산책 부장",
];

const pick = <T>(values: readonly T[], byte: number) => values[byte % values.length]!;

export function createKoreanNickname(entropy: Uint8Array = randomBytes(4)): string {
  const template = entropy[0]! % 8;
  const first = entropy[1]!;
  const second = entropy[2]!;
  if (template === 0) return `${pick(moods, first)} ${pick(animals, second)}`;
  if (template === 1) return `${pick(foods, first)} 지키는 ${pick(animals, second)}`;
  if (template === 2) return `${pick(places, first)}에서 춤추는 ${pick(animals, second)}`;
  if (template === 3) return `${pick(foods, first)} 먹다 들킨 ${pick(animals, second)}`;
  if (template === 4) return `${pick(challenges, first)} 이겨낸 ${pick(animals, second)}`;
  if (template === 5) return `${pick(times, first)}에 깨어난 ${pick(animals, second)}`;
  if (template === 6) return `${pick(rides, first)} 타고 온 ${pick(animals, second)}`;
  return `${pick(places, first)}의 ${pick(roles, second)}`;
}
