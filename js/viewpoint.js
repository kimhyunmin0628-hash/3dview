// 클릭한 건물 입면 지점에 카메라를 이동시켜, 그 지점(그 층/그 창문)에서 바라보는 조망을 재현한다.
//
// 벽면의 정확한 법선(normal)은 3D 타일 지오메트리에서 직접 얻기 어려우므로, buildingPicker.js가
// 클릭 시점에 "클릭 지점 -> 클릭 당시 카메라 위치" 방위각(picked.viewBearingDeg)을 그 벽면의
// 바깥쪽 방향으로 근사해서 넘겨준다(Cesium은 카메라를 향한 면만 pick하므로 카메라는 항상
// 벽 바깥쪽에 있다).

const METERS_PER_DEGREE_LAT = 111320;

function bearingDegrees(lon1, lat1, lon2, lat2) {
  const phi1 = toRad(lat1);
  const phi2 = toRad(lat2);
  const dLambda = toRad(lon2 - lon1);
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function flyToViewpoint(viewer, picked, onComplete) {
  const headingDeg = picked.viewBearingDeg;
  const headingRad = toRad(headingDeg);

  // 클릭 지점에서 바깥으로 2m 더 나가 벽에 파묻히지 않게 하고, 눈높이(1.5m)를 더한다.
  const outwardMeters = 2;
  const dLat = (outwardMeters * Math.cos(headingRad)) / METERS_PER_DEGREE_LAT;
  const dLon =
    (outwardMeters * Math.sin(headingRad)) / (METERS_PER_DEGREE_LAT * Math.cos(toRad(picked.lat)));

  const eyeLon = picked.lon + dLon;
  const eyeLat = picked.lat + dLat;
  const eyeHeight = picked.clickedHeight + 1.5;

  const destination = geodeticToCartesian(viewer, eyeLon, eyeLat, eyeHeight);

  viewer.camera.flyTo({
    destination,
    orientation: {
      heading: headingRad,
      pitch: 0, // 수평 시선. 필요하면 UI에서 조절 가능하게 확장.
      roll: 0,
    },
    duration: 1.5,
    complete: () => {
      if (onComplete) onComplete({ destination, headingRad });
    },
  });
}

// 벽면 앞 고정된 지점에서 제자리 회전(좌우 heading / 상하 pitch)만 허용하는 컨트롤.
// createOrbitControl과 달리 카메라 위치(eye)는 절대 바뀌지 않고 바라보는 방향만 바뀐다.
// 좌우 회전은 그 벽의 바깥쪽(headingRad)을 기준으로 +-VIEWPOINT_HEADING_RANGE_DEG 안에서만
// 움직여서, 돌아서서 벽 쪽을 보는 상황(반대편으로 못 나가게)을 막는다.
const VIEWPOINT_HEADING_RANGE_DEG = 85;
const VIEWPOINT_PITCH_MIN_DEG = -70;
const VIEWPOINT_PITCH_MAX_DEG = 80;

function createViewpointLookControl(viewer, position, baseHeadingRad) {
  const baseHeadingDeg = toDeg(baseHeadingRad);
  let headingDeg = baseHeadingDeg;
  let pitchDeg = 0;

  function clampHeadingDeg(deg) {
    let diff = ((deg - baseHeadingDeg + 540) % 360) - 180; // -180 ~ 180 사이로 정규화
    diff = Math.max(-VIEWPOINT_HEADING_RANGE_DEG, Math.min(VIEWPOINT_HEADING_RANGE_DEG, diff));
    return (baseHeadingDeg + diff + 360) % 360;
  }

  function apply() {
    viewer.camera.setView({
      destination: position,
      orientation: { heading: toRad(headingDeg), pitch: toRad(pitchDeg), roll: 0 },
    });
  }

  return {
    // 전체보기(orbit) 모드와 좌/우 버튼 방향이 반대가 되도록 하는 표시. main.js가 읽어서 사용한다.
    invertHeading: true,

    begin() {
      return true;
    },
    currentHeadingDegrees() {
      return headingDeg;
    },
    currentElevationDegrees() {
      return pitchDeg;
    },
    setHeadingDegrees(deg) {
      headingDeg = clampHeadingDeg(deg);
      apply();
    },
    setElevationDegrees(deg) {
      pitchDeg = Math.max(VIEWPOINT_PITCH_MIN_DEG, Math.min(VIEWPOINT_PITCH_MAX_DEG, deg));
      apply();
    },
  };
}

function saveCameraState(viewer) {
  const camera = viewer.camera;
  return {
    destination: { x: camera.position.x, y: camera.position.y, z: camera.position.z },
    orientation: {
      heading: camera.heading,
      pitch: camera.pitch,
      roll: camera.roll,
    },
  };
}

function flyToOverview(viewer, savedState) {
  if (!savedState) return;
  viewer.camera.flyTo({
    destination: savedState.destination,
    orientation: savedState.orientation,
    duration: 1.5,
  });
}
