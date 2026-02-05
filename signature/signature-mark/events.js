(function(SignatureMark){
  SignatureMark.prototype.initEvents = function() {
    var self = this;

    // Use PointerEvents for unified mouse, touch, and pen (Wacom) support
    self.canvas.addEventListener('pointerdown', function(e)  { self.onCanvasMouseDown(self, e); }, false);
    self.canvas.addEventListener('pointermove', function(e)  { self.onCanvasMouseMove(self, e); }, false);
    self.canvas.addEventListener('pointerup', function(e)    { self.onCanvasMouseUp(self, e); }, false);
    self.canvas.addEventListener('pointercancel', function(e){ self.onCanvasMouseUp(self, e); }, false);
    self.canvas.addEventListener('contextmenu', function(e)  { self.preventRightClick(self, e); }, false);

    document.addEventListener('pointerup', function(e)       { self.onCanvasMouseUp(self, e); }, false);

    // Prevent touch scrolling while drawing
    self.canvas.style.touchAction = 'none';
  };

  SignatureMark.prototype.preventRightClick = function(self, e) {
    e.preventDefault();
  };

  SignatureMark.prototype.onCanvasMouseDown = function(self, e) {
    e.preventDefault();
    self.canvas.setPointerCapture(e.pointerId);
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
    // PointerEvents always have pageX/pageY directly on the event
    var rawX = event.pageX - self.canvasOffsetLeft;
    var rawY = event.pageY - self.canvasOffsetTop;
    // Scale from CSS pixels to canvas internal pixels (fixes Retina/scaled displays)
    var scaleX = self.canvas.width / self.canvas.offsetWidth;
    var scaleY = self.canvas.height / self.canvas.offsetHeight;
    self.mouseX = rawX * scaleX;
    self.mouseY = rawY * scaleY;
  };

  SignatureMark.prototype.setCanvasOffset = function(self) {
    canvasOffset              = self.Offset(self.canvas);
    self.canvasOffsetLeft     = canvasOffset.left;
    self.canvasOffsetTop      = canvasOffset.top;
  };
}(SignatureMark));
