// 건물이 지역별로 뜨거나 파묻히던 문제의 핵심 해결부.
// vworld 3D지도 API는 전역 Cesium 네임스페이스를 노출하지 않지만, viewer.scene.globe.ellipsoid /
// viewer.scene.globe 자체는 실제 Cesium 인스턴스라 좌표 변환과 지형 높이 조회 메서드를 그대로 쓸 수 있다.
// 절대 다른 출처의 표고값을 하드코딩하지 말고, 매번 이 지형(=vworld 지형)에서 직접 조회한 값만 쓴다.
// 그래야 지형과 건물이 항상 같은 소스/같은 수직기준을 쓰게 되어 지역별 편차 문제가 사라진다.

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

function toDeg(rad) {
  return (rad * 180) / Math.PI;
}

function getEllipsoid(viewer) {
  return viewer.scene.globe.ellipsoid;
}

// ECEF Cartesian3 -> {lon, lat(도 단위), height(m)}
function cartesianToGeodetic(viewer, cartesian) {
  const carto = getEllipsoid(viewer).cartesianToCartographic(cartesian);
  return {
    lon: toDeg(carto.longitude),
    lat: toDeg(carto.latitude),
    height: carto.height,
  };
}

// {lon, lat(도 단위), height(m)} -> ECEF Cartesian3
function geodeticToCartesian(viewer, lon, lat, height) {
  return getEllipsoid(viewer).cartographicToCartesian({
    longitude: toRad(lon),
    latitude: toRad(lat),
    height: height,
  });
}

// 그 위경도에서 vworld 지형이 실제로 렌더링 중인 지반고(m).
// 아직 타일이 로드되지 않은 위치면 undefined가 올 수 있어 0으로 대체한다.
function sampleGroundHeight(viewer, lon, lat) {
  const height = viewer.scene.globe.getHeight({
    longitude: toRad(lon),
    latitude: toRad(lat),
  });
  return typeof height === "number" ? height : 0;
}

// 위경도 + 지반 기준 상대 높이(extraHeight)로 절대 좌표를 만든다.
function cartesianOnGround(viewer, lon, lat, extraHeight = 0) {
  const groundHeight = sampleGroundHeight(viewer, lon, lat);
  return {
    cartesian: geodeticToCartesian(viewer, lon, lat, groundHeight + extraHeight),
    groundHeight,
  };
}
