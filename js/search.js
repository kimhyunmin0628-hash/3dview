// 아파트 단지명 / 동(행정구역) 검색.
// vworld 검색 API(api.vworld.kr)는 CORS 헤더를 내려주지 않아 fetch로 바로 못 부르므로,
// 표준 JSONP(<script> 태그 + callback 파라미터) 방식으로 우회한다. 실제로 curl로 확인한 결과
// type=place 검색 하나로 "아파트단지"(카테고리: 시설구역경계>아파트단지)와
// "동"(카테고리: 읍면동구역경계>법정동/행정동)이 모두 첫 번째 결과로 잘 매칭된다.

let __vworldJsonpCounter = 0;

function vworldSearchJsonp(query) {
  return new Promise((resolve, reject) => {
    const callbackName = `__vworldSearchCb_${__vworldJsonpCounter++}`;
    const script = document.createElement("script");

    const timeoutId = setTimeout(() => {
      cleanup();
      reject(new Error("검색 응답이 너무 오래 걸립니다."));
    }, 8000);

    function cleanup() {
      clearTimeout(timeoutId);
      delete window[callbackName];
      if (script.parentNode) script.parentNode.removeChild(script);
    }

    window[callbackName] = (data) => {
      cleanup();
      resolve(data);
    };

    script.onerror = () => {
      cleanup();
      reject(new Error("검색 요청에 실패했습니다."));
    };

    const url =
      `https://api.vworld.kr/req/search?service=search&request=search&version=2.0` +
      `&query=${encodeURIComponent(query)}&type=place&format=json` +
      `&key=${encodeURIComponent(VWORLD_CONFIG.apiKey)}&callback=${callbackName}`;
    script.src = url;
    document.body.appendChild(script);
  });
}

// 검색어로 위치를 찾아 {lon, lat, title}을 반환한다. 결과가 없으면 null.
async function searchLocation(query) {
  const data = await vworldSearchJsonp(query);
  const response = data && data.response;
  if (!response || response.status !== "OK") return null;

  const items = response.result && response.result.items;
  if (!items || items.length === 0) return null;

  const first = items[0];
  return {
    lon: parseFloat(first.point.x),
    lat: parseFloat(first.point.y),
    title: first.title || (first.address && (first.address.road || first.address.parcel)) || query,
  };
}
