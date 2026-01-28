(function(SignatureMark){
  SignatureMark.prototype.initEvents = function() {
    var self = this;
    self.canvas.addEventListener(self.mouse_down, function(e)     { self.onCanvasMouseDown(self, e); }, false);
    self.canvas.addEventListener(self.mouse_move, function(e)     { self.onCanvasMouseMove(self, e); }, false);
    self.canvas.addEventListener('contextmenu', function(e)       { self.preventRightClick(self, e); }, false);

    document.addEventListener(self.mouse_up, function(e)          { self.onCanvasMouseUp(self, e); }, false);
    self.canvas.addEventListener(self.mouse_up, function(e)       { self.onCanvasMouseUp(self, e); }, false);  
  };

  SignatureMark.prototype.preventRightClick = function(self, e) {
    e.preventDefault();
  };

  SignatureMark.prototype.onCanvasMouseDown = function(self, e) {
    e.preventDefault();
    self.setCanvasOffset(self);
    self.startDrawingStroke(self);
    self.setMouseXAndMouseY(self, e);
    self.setPainters(self);
  };

  SignatureMark.prototype.onCanvasMouseMove = function(self, e) {
    e.preventDefault();
    self.setMouseXAndMouseY(self, e);
  };

  SignatureMark.prototype.onCanvasMouseUp = function(self, e) {
    self.stopDrawingStroke(self);
  };

  SignatureMark.prototype.setMouseXAndMouseY = function(self, event) {
    var rawX, rawY;
    if (!!self.touch_supported) {
      target                 = event.touches[0];
      rawX                   = target.pageX - self.canvasOffsetLeft;
      rawY                   = target.pageY - self.canvasOffsetTop;
    } else {
      rawX                   = event.pageX - self.canvasOffsetLeft;
      rawY                   = event.pageY - self.canvasOffsetTop;
    }
    // Scale from CSS pixels to canvas internal pixels (fixes Retina/scaled displays)
    var scaleX = self.canvas.width / self.canvas.offsetWidth;
    var scaleY = self.canvas.height / self.canvas.offsetHeight;
    self.mouseX            = rawX * scaleX;
    self.mouseY            = rawY * scaleY;
  };

  SignatureMark.prototype.setCanvasOffset = function(self) {
    canvasOffset              = self.Offset(self.canvas);
    self.canvasOffsetLeft     = canvasOffset.left;
    self.canvasOffsetTop      = canvasOffset.top;
  };
}(SignatureMark));