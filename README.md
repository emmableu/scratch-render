## Scratch Render Patched for WebPack

The original [scratch-render](https://github.com/LLK/scratch-render) does not work as a node_module with Create React App when importing sprite.vert and sprite.frag in ShadeManager.js:  
it would output this error: 
```$xslt
twgl-full.js:1788 1: #define DRAW_MODE_default
2: #define ENABLE_fisheye
3: #define ENABLE_mosaic
4: #define ENABLE_ghost
5: export default "#define GLSLIFY 1\nexport default __webpack_public_path__ + \"static/media/sprite.485d82de.vert\";";
*** Error compiling shader: ERROR: 0:5: 'export' : syntax error
```

To fix it, this code repository add [this small update](https://github.com/emmableu/scratch-render/commit/484252ba17438fa27deb930c7a3ec090deef9fb0) to the master branch of scratch-render.

The installment and other things are the same as the original [scratch-render](https://github.com/LLK/scratch-render) repo.  
 
