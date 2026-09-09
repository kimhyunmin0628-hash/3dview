// vworld 웹GL 3D지도 API 초기화.
// ion.cesium.com 계정/글로벌 테레인은 전혀 쓰지 않는다 — 지형/영상/건물을 전부 vworld 한 곳에서만 받는다.
// vworld 스크립트 자체는 index.html의 <head>에 정적 <script> 태그로 이미 로드되어 있다
// (document.write로 내부 의존 스크립트를 불러오는 방식이라 동적 주입은 실패한다).

function waitForVw(timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    if (typeof vw !== "undefined") {
      resolve();
      return;
    }
    const start = Date.now();
    const interval = setInterval(() => {
      if (typeof vw !== "undefined") {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        reject(new Error("vw 전역 객체가 나타나지 않았습니다. index.html의 vworld script 태그(apiKey/domain)를 확인하세요."));
      }
    }, 100);
  });
}

// vworld의 Map 객체가 내부적으로 들고 있는 Cesium.Viewer 인스턴스를 찾아낸다.
// 실제 브라우저에서 콘솔로 확인한 결과 map._wsViewer가 진짜 Cesium.Viewer 인스턴스다
// (scene/camera/terrainProvider 전부 정상 확인됨). 혹시 이후 vworld 버전이 바뀌어
// 속성명이 달라지는 경우를 대비해 몇 가지 후보를 더 시도한다.
function resolveCesiumViewer(map) {
  const candidates = [
    () => map._wsViewer,
    () => map.getViewer && map.getViewer(),
    () => map.viewer,
    () => map._viewer,
    () => map.getCesiumViewer && map.getCesiumViewer(),
    () => map.cesiumViewer,
  ];

  for (const getIt of candidates) {
    try {
      const v = getIt();
      if (v && v.scene && v.camera) {
        console.info("[vworldBootstrap] Cesium viewer 확보 성공:", getIt.toString());
        return v;
      }
    } catch (e) {
      // 다음 후보 시도
    }
  }

  console.warn(
    "[vworldBootstrap] 알려진 방식으로 Cesium viewer를 찾지 못했습니다. " +
      "아래 map 객체를 콘솔에서 펼쳐 viewer/scene/camera가 들어있는 속성명을 확인한 뒤 " +
      "resolveCesiumViewer()의 candidates 배열에 추가해주세요.",
    map
  );
  return null;
}

async function initVWorldMap(containerId) {
  await waitForVw();

  const cam = INITIAL_CAMERA;

  const mapOptions = new vw.MapOptions();
  mapOptions.basemapType = vw.BasemapType.GRAPHIC;
  mapOptions.controlDensity = vw.DensityType.BASIC;
  mapOptions.interactionDensity = vw.DensityType.BASIC;
  mapOptions.controlsAutoArrange = true;
  mapOptions.homePosition = new vw.CameraPosition(
    new vw.CoordZ(cam.lon, cam.lat, cam.height),
    new vw.Direction(cam.heading, cam.pitch, 0)
  );
  mapOptions.initPosition = mapOptions.homePosition;

  const map = new vw.Map(containerId, mapOptions);
  window.__vwMap = map; // 디버깅용: 콘솔에서 구조 확인

  // 지도/지형/건물 타일이 실제로 로드될 시간을 약간 준다.
  await new Promise((r) => setTimeout(r, 1500));

  const viewer = resolveCesiumViewer(map);
  if (!viewer) {
    throw new Error(
      "Cesium viewer를 확보하지 못했습니다. 콘솔에 출력된 map 객체를 확인하고 " +
        "vworldBootstrap.js의 resolveCesiumViewer()를 실제 속성명으로 수정해주세요."
    );
  }

  return { map, viewer };
}
