(function(SignatureMark){
  SignatureMark.prototype.initVariables = function() {
    this.context              = this.canvas.getContext('2d');
    this.color                = [0, 0, 0];
    this.brush_pressure       = 0.5;
    this.context.strokeStyle  = "rgba(" + this.color[0] + ", " + this.color[1] + ", " + this.color[2] + ", " + this.brush_pressure + ")";
    this.context.lineWidth    = 2.5; // brush size
    this.painters             = [];
    this.mouseX               = 0;
    this.mouseY               = 0;
    this.strokeIntervals      = [];
    this.refresh_rate         = 5;
    this.max_strokes          = 12;
    this.easing               = 0.7;
  };

}(SignatureMark));
