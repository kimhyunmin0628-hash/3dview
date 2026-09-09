// 화면 중심 지점을 기준으로 카메라를 돌리는 컨트롤.
// - heading(좌우) 슬라이더: 화면 중심점을 축으로 카메라가 수평으로 도는 방위각.
// - elevation(상하) 슬라이더: 지면 기준으로 내려다보는 각도(0=거의 지면 높이에서 수평으로,
//   90=바로 위에서 수직으로 내려다보기).
//
// 주의: Cesium의 camera.lookAt(target, {heading,pitch,range})는 카메라의 참조 프레임(transform)을
// 대상 지점 기준 로컬 프레임으로 바꿔버려서, 이후 camera.position/setView가 전부 그 프레임
// 기준으로 해석되어 버린다(리셋 안 하면 좌표가 전부 깨짐). 그래서 lookAt은 아예 쓰지 않고,
// 항상 고정 ECEF 좌표계에서 직접 궤도 위치를 계산해 camera.setView로 옮긴다.

function vec3Distance(a, b) {
  const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

function orbitCameraPosition(viewer, pivot, headingRad, elevationRad, range) {
  const ellipsoid = viewer.scene.globe.ellipsoid;
  const carto = ellipsoid.cartesianToCartographic(pivot);
  const lon = carto.longitude, lat = carto.latitude;

  const up = { x: Math.cos(lat) * Math.cos(lon), y: Math.cos(lat) * Math.sin(lon), z: Math.sin(lat) };
  const east = { x: -Math.sin(lon), y: Math.cos(lon), z: 0 };
  const north = {
    x: up.y * east.z - up.z * east.y,
    y: up.z * east.x - up.x * east.z,
    z: up.x * east.y - up.y * east.x,
  };

  const horiz = Math.cos(elevationRad);
  const dirEast = horiz * Math.sin(headingRad);
  const dirNorth = horiz * Math.cos(headingRad);
  const dirUp = Math.sin(elevationRad);

  return {
    x: pivot.x + (east.x * dirEast + north.x * dirNorth + up.x * dirUp) * range,
    y: pivot.y + (east.y * dirEast + north.y * dirNorth + up.y * dirUp) * range,
    z: pivot.z + (east.z * dirEast + north.z * dirNorth + up.z * dirUp) * range,
  };
}

function pickScreenCenter(viewer) {
  const canvas = viewer.scene.canvas;
  const centerPixel = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
  return (
    viewer.scene.pickPosition(centerPixel) ||
    viewer.camera.pickEllipsoid(centerPixel, viewer.scene.globe.ellipsoid)
  );
}

const ORBIT_ELEVATION_MIN_DEG = 5;
const ORBIT_ELEVATION_MAX_DEG = 85;

function createOrbitControl(viewer) {
  let pivot = null;
  let range = 500;
  let headingRad = 0;
  let elevationRad = toRad(45);

  return {
    // dpad 좌/우 스텝 부호는 main.js에서 이 값을 보고 정한다. 조망 모드(viewpoint.js의
    // createViewpointLookControl)는 이걸 true로 둬서 전체보기와 반대로 움직이게 한다.
    invertHeading: false,

    // 슬라이더 조작을 시작하기 직전에 호출: 지금 화면 중심점/거리/각도를 기준으로 삼는다.
    // 이렇게 해야 그 사이 사용자가 vworld 기본 조작(드래그/휠줌)으로 view를 바꿔놔도 안 튄다.
    begin() {
      const picked = pickScreenCenter(viewer);
      if (!picked) return false;
      pivot = picked;
      range = Math.max(30, vec3Distance(viewer.camera.position, pivot));
      headingRad = toRad(((viewer.camera.heading * 180) / Math.PI - 180 + 360) % 360);
      elevationRad = toRad(Math.max(1, Math.min(89, -((viewer.camera.pitch * 180) / Math.PI))));
      return true;
    },

    currentHeadingDegrees() {
      return (toDeg(headingRad) + 360) % 360;
    },

    currentElevationDegrees() {
      return toDeg(elevationRad);
    },

    setHeadingDegrees(deg) {
      if (!pivot) return;
      headingRad = toRad(deg);
      apply();
    },

    setElevationDegrees(deg) {
      if (!pivot) return;
      elevationRad = toRad(Math.max(ORBIT_ELEVATION_MIN_DEG, Math.min(ORBIT_ELEVATION_MAX_DEG, deg)));
      apply();
    },
  };

  function apply() {
    const camPos = orbitCameraPosition(viewer, pivot, headingRad, elevationRad, range);
    viewer.camera.setView({
      destination: camPos,
      orientation: {
        heading: (headingRad + Math.PI) % (2 * Math.PI),
        pitch: -elevationRad,
        roll: 0,
      },
    });
  }
}
