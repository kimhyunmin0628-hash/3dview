// vworld 개발자센터(https://www.vworld.kr)에서 발급받은 인증키 / 등록 도메인
const VWORLD_CONFIG = {
  apiKey: "639AD4BC-A578-4234-92BB-BA8A02E9936D",
  // 로컬에서 테스트할 땐 vworld에 등록한 도메인과 실제 접속 도메인이 같아야 인증이 통과됩니다.
  // 보통 "localhost" 또는 "127.0.0.1"을 등록해두고 씁니다. vworld 마이페이지에서 등록 도메인을 확인하세요.
  domain: "localhost",
};

// 서비스 시작 시 보여줄 초기 위치: 압구정동 현대아파트.
// vworld 검색 API(type=place)로 직접 조회해서 확인한 실제 좌표(POI01000000BYHMEM, "현대아파트" 시설구역경계>아파트단지).
const DEFAULT_LOCATION = { name: "압구정동 현대아파트", region: "서울 강남구", lon: 127.0274814530653, lat: 37.5328328771066 };

const INITIAL_CAMERA = {
  lon: DEFAULT_LOCATION.lon,
  lat: DEFAULT_LOCATION.lat,
  height: 900,
  heading: 0,
  pitch: -40,
};

// 건물 클릭 지점의 층수를 추정할 때 쓰는 평균 층고(m).
// 실제 서비스에서는 단지별 정확한 층고 데이터로 교체하는 걸 권장합니다.
const FLOOR_HEIGHT_M = 2.8;

// 사이드바에 표시할 예시 아파트 데이터.
// 실제 서비스에서는 여기 대신 자체 DB나 검색 결과 히스토리로 채우면 됩니다.
const SAMPLE_APARTMENTS = [
  DEFAULT_LOCATION,
  { name: "래미안 대치팰리스", region: "서울 강남구", lon: 127.0552, lat: 37.4945 },
  { name: "파크리오", region: "서울 송파구", lon: 127.0959, lat: 37.5010 },
  { name: "헬리오시티", region: "서울 송파구", lon: 127.1218, lat: 37.4956 },
  { name: "마포래미안푸르지오", region: "서울 마포구", lon: 126.9445, lat: 37.5580 },
  { name: "판교푸르지오그랑블", region: "경기 성남시", lon: 127.1078, lat: 37.3947 },
  { name: "동탄역센트럴자이", region: "경기 화성시", lon: 127.0985, lat: 37.2004 },
];
