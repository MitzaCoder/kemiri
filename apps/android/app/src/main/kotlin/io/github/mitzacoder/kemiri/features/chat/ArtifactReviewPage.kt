package io.github.mitzacoder.kemiri.features.chat

/** Only evaluateJavascript reads this document-local state. No bridge, messages, URLs or origin grants. */
internal val ARTIFACT_REVIEW_READ = """
(function(){
 function clean(s,n){s=String(s||'').slice(0,n+1);return s.length>n?s.slice(0,n-1)+'…':s}
 function report(text,e,block){var h='',hs=document.querySelectorAll('h1,h2,h3,h4,h5,h6');for(var i=0;e&&i<hs.length;i++){if(hs[i].contains(e)||(hs[i].compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING))h=hs[i].textContent;else break}var r={type:'kemiri:artifact-selection',text:clean(text,4000),section:clean(h,300),elementId:clean(e&&(e.closest('[id]')||{}).id,120)};if(block)r.block=block;return r}
 if(!window.kemiriArtifactReview){var state={picked:null,picking:false,report:report};window.kemiriArtifactReview=state;
 document.addEventListener('click',function(event){if(!state.picking)return;event.preventDefault();event.stopImmediatePropagation();var e=event.target.closest&&event.target.closest('svg,canvas,img,figure,tr,pre,li,blockquote,p');if(!e)return;var tag=e.tagName.toLowerCase(),labels={svg:'chart',canvas:'chart',img:'image',figure:'figure',tr:'table row',pre:'code',li:'list item',blockquote:'paragraph',p:'paragraph'},caption=e.querySelector('figcaption,title');state.picked=report(e.getAttribute('aria-label')||e.getAttribute('alt')||(caption&&caption.textContent)||e.textContent||e.getAttribute('title')||labels[tag],e,labels[tag]);state.picking=false},true)}
 var state=window.kemiriArtifactReview;if(state.picked){var picked=state.picked;state.picked=null;return JSON.stringify(picked)}
 var s=getSelection(),node=s&&s.anchorNode,e=node&&(node.nodeType===1?node:node.parentElement);if(e&&e.closest('input,textarea,[contenteditable="true"]'))return null;
 return JSON.stringify(report(s?s.toString():'',e));
})();
""".trimIndent()
internal val ARTIFACT_REVIEW_PICK = """(function(){window.kemiriArtifactReview.picked=null;window.kemiriArtifactReview.picking=true;getSelection().removeAllRanges();})()"""
internal val ARTIFACT_REVIEW_CANCEL_PICK = """(function(){if(window.kemiriArtifactReview){window.kemiriArtifactReview.picking=false;window.kemiriArtifactReview.picked=null;}})()"""
