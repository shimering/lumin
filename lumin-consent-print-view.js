window.addEventListener('load',()=>{
  if(window.opener)window.opener.postMessage('lumin-consent-print-ready',window.location.origin);
},{once:true});
