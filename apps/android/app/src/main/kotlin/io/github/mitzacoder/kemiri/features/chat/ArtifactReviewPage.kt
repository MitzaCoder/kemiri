package io.github.mitzacoder.kemiri.features.chat

/** Only evaluateJavascript reads this document-local state. No bridge, messages, URLs or origin grants. */
internal val ARTIFACT_REVIEW_READ = """
(function(){
 function clean(s,n){s=String(s||'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g,'').trim();return s.length>n?s.slice(0,n-1)+'…':s}
 function path(e){var parts=[];while(e&&e!==document.body){var parent=e.parentElement;if(!parent)return'';parts.unshift(Array.prototype.indexOf.call(parent.children,e));e=parent}var result=parts.join('.');return e===document.body&&/^\d{1,5}(?:\.\d{1,5}){0,39}$/.test(result)?result:''}
 function report(text,e,block){var h='',hs=document.querySelectorAll('h1,h2,h3,h4,h5,h6');for(var i=0;e&&i<hs.length;i++){if(hs[i].contains(e)||(hs[i].compareDocumentPosition(e)&Node.DOCUMENT_POSITION_FOLLOWING))h=hs[i].textContent;else break}var r={type:'kemiri:artifact-selection',text:clean(text,4000),section:clean(h,300),elementId:clean(e&&(e.closest('[id]')||{}).id,120)};if(block)r.block=block;var anchor=r.text&&path(block?e:candidate(e)||e);if(anchor)r.anchor=anchor;return r}
 function visible(element){if(!element||element===document.body||element===document.documentElement)return false;var rect=element.getBoundingClientRect(),style=getComputedStyle(element);return rect.width>0&&rect.height>0&&style.visibility!=='hidden'&&style.visibility!=='collapse'&&style.display!=='none'}
 function candidate(target){if(!(target instanceof Element)||!visible(target))return null;var graphic=target.closest('[role="img"],svg,canvas,img,figure,video,iframe,object,embed');if(visible(graphic))return graphic;var semantic=target.closest('tr,pre,li,blockquote,p,h1,h2,h3,h4,h5,h6');if(visible(semantic))return semantic;for(var element=target;element&&element!==document.body&&element!==document.documentElement;element=element.parentElement){if(!visible(element))continue;var display=getComputedStyle(element).display;if(display!=='inline'&&display!=='contents')return element}return target}
 function blocks(){var found=[];Array.from(document.querySelectorAll('body *')).forEach(function(element){var block=candidate(element);if(block&&found.indexOf(block)<0)found.push(block)});return found}
 function blockLabel(element){var tag=element.tagName.toLowerCase();var labels={svg:'chart',canvas:'chart',img:'image',figure:'figure',tr:'table row',pre:'code',li:'list item',blockquote:'paragraph',p:'paragraph'};return element.getAttribute('role')==='img'?'image':labels[tag]||'block'}
 function description(element){var labelled=clean((element.getAttribute('aria-labelledby')||'').split(/\s+/).map(function(id){var label=document.getElementById(id);return label?label.textContent:''}).join(' '),4000);var caption=element.querySelector('figcaption,title'),heading=element.querySelector('h1,h2,h3,h4,h5,h6');return clean(element.getAttribute('aria-label'),4000)||labelled||clean(element.getAttribute('alt'),4000)||clean(caption&&caption.textContent,4000)||clean(heading&&heading.textContent,4000)||clean(element.innerText||element.textContent,4000)||clean(element.getAttribute('title'),4000)||blockLabel(element)+' ('+element.tagName.toLowerCase()+')'}
 function unoutline(){if(state.outlined)state.outlined.removeAttribute('data-kemiri-review-pick');state.outlined=null}
 function stop(){state.picking=false;unoutline();document.documentElement.removeAttribute('data-kemiri-review-picking')}
 function pick(e){if(!e)return;state.picked=report(description(e),e,blockLabel(e));stop()}
 if(!window.kemiriArtifactReview){var state={picked:null,picking:false,outlined:null,index:-1,report:report,stop:stop};window.kemiriArtifactReview=state;
 var style=document.createElement('style');style.textContent='[data-kemiri-review-picking] *{cursor:crosshair}[data-kemiri-review-pick]{outline:3px solid var(--tone-primary,#6267a3)!important;outline-offset:3px}';document.head.appendChild(style);
 document.addEventListener('pointerover',function(event){if(!state.picking)return;unoutline();state.outlined=candidate(event.target);if(state.outlined)state.outlined.setAttribute('data-kemiri-review-pick','')},true);
 document.addEventListener('click',function(event){if(!state.picking)return;event.preventDefault();event.stopImmediatePropagation();pick(candidate(event.target))},true);
 document.addEventListener('keydown',function(event){if(!state.picking)return;if(event.key==='Escape'){stop();state.picked=report('',null);event.preventDefault();event.stopImmediatePropagation()}else if(event.key==='ArrowDown'||event.key==='ArrowUp'){var available=blocks();if(available.length){state.index=(state.index+(event.key==='ArrowDown'?1:-1)+available.length)%available.length;unoutline();state.outlined=available[state.index];state.outlined.setAttribute('data-kemiri-review-pick','');state.outlined.scrollIntoView({block:'nearest'})}event.preventDefault();event.stopImmediatePropagation()}else if(event.key==='Enter'){event.preventDefault();event.stopImmediatePropagation();pick(state.outlined||candidate(event.target))}},true)}

 var state=window.kemiriArtifactReview;if(state.picked){var picked=state.picked;state.picked=null;return JSON.stringify(picked)}
 if(state.picking)return null;
 var s=getSelection(),node=s&&(s.rangeCount?s.getRangeAt(0).startContainer:s.anchorNode),e=node&&(node.nodeType===1?node:node.parentElement);if(e&&e.closest('input,textarea,[contenteditable="true"]'))return null;
 return JSON.stringify(report(s?s.toString():'',e));
})();
""".trimIndent()
internal val ARTIFACT_REVIEW_PICK = """(function(){window.kemiriArtifactReview.picked=null;window.kemiriArtifactReview.picking=true;window.kemiriArtifactReview.index=-1;document.documentElement.setAttribute('data-kemiri-review-picking','');getSelection().removeAllRanges();})()"""
internal val ARTIFACT_REVIEW_CANCEL_PICK = """(function(){if(window.kemiriArtifactReview){window.kemiriArtifactReview.stop();window.kemiriArtifactReview.picked=null;}})()"""


/** Reads only paths chosen by native code; pinch zoom and visual viewport offsets are measured inside the document. */
internal val ARTIFACT_REVIEW_RECTS = """
(function(paths){
 var viewport=window.visualViewport, width=viewport?viewport.width:window.innerWidth, height=viewport?viewport.height:window.innerHeight;
 var x=viewport?viewport.offsetLeft:0,y=viewport?viewport.offsetTop:0;
 var scrollX=viewport?viewport.pageLeft:window.scrollX,scrollY=viewport?viewport.pageTop:window.scrollY;
 var rects=paths.map(function(path){
   var element=document.body;
   path.split('.').forEach(function(index){element=element&&element.children[Number(index)]});
   if(!element)return '';
   var style=getComputedStyle(element), box=element.getBoundingClientRect();
   if(style.visibility!=='visible'||box.width<=0||box.height<=0)return '';
   var scrollsWithPage=1;
   for(var ancestor=element;ancestor;ancestor=ancestor.parentElement){
     var position=(ancestor===element?style:getComputedStyle(ancestor)).position;
     if(position==='fixed'||position==='sticky'){scrollsWithPage=0;break}
   }
   return path+'='+[box.left-x,box.top-y,box.width,box.height,scrollsWithPage].map(Math.round).join(',');
 }).filter(Boolean).join('|');
 return JSON.stringify({width:Math.round(width),height:Math.round(height),scrollX:Math.round(scrollX),scrollY:Math.round(scrollY),rects:rects});
})
""".trimIndent()
