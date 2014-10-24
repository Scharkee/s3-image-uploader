'use strict';

// WS - A Websocket library: https://www.npmjs.org/package/ws
var WebSocketServer = require('ws').Server;
// Let's not re-invent the wheel. A high level S3 uploader: https://www.npmjs.org/package/s3
var s3 = require('s3');
// GraphicsMagick - For image manipulation: https://github.com/aheckmann/gm
var gm = require('gm');

// Constructor
var Uploader = function(options){

  if(typeof options.server === 'undefined') throw new Error('Uploader: "server" is not defined.');
  if(typeof options.aws.key === 'undefined') throw new Error('Uploader: "aws.key" is not defined.');
  if(typeof options.aws.secret === 'undefined') throw new Error('Uploader: "aws.secret" is not defined.');

  this.options = options;
  // set websocket as false initially
  this.ws = false;

  // create the s3 client
  this.client = s3.createClient({
    s3Options: {
      accessKeyId: this.options.aws.key,
      secretAccessKey: this.options.aws.secret
    }
  });

};

// Handle websocket connection
Uploader.prototype.websocket = function(){

  var self = this;
  var ws = new WebSocketServer({ server: self.options.server });

  ws.on('connection', function(ws) {
    self.ws = ws;
  });

};

// Resize image and add to destination directory
Uploader.prototype.resize = function(options, successCallback, errorCallback){

  if(typeof options.fileId === 'undefined') throw new Error('Uploader.resize: "fileId" is not defined.');
  if(typeof options.width === 'undefined') throw new Error('Uploader.resize: "width" is not defined.');
  if(typeof options.height === 'undefined') throw new Error('Uploader.resize: "height" is not defined.');
  if(typeof options.source === 'undefined') throw new Error('Uploader.resize: "source" is not defined.');
  if(typeof options.destination === 'undefined') throw new Error('Uploader.resize: "destination" is not defined.');
  // defaults
  if(typeof options.quality === 'undefined') options.quality = 100;
  if(typeof options.square === 'undefined') options.square = false;
  if(typeof options.noProfile === 'undefined') options.noProfile = true;
  if(typeof options.maxFileSize === 'undefined') options.maxFileSize = false; // unlimited by default

  var self = this;

  // get image size and execute callback
  _imageSize(options.source, function(err, size){

    var _startResize = function(){
      _resize(options, size, function(img, destination){
        var status = {
          type : 'resize',
          id : options.fileId,
          size : options.width + 'x' + options.height
        };
        if(self.ws){
          self.ws.send(JSON.stringify(status), function(error) {
            if(error) console.log("WS send error:", error);
          });
        }
        successCallback.call(img, destination);
      }, errorCallback);
    };

    // if maxFileSize is set - get the filesize info and validate
    if(options.maxFileSize){
      _imageFileSize(options.source, function(err, fileSize){
        var fileSize = parseFloat(fileSize.replace('M', ''));
        if(options.maxFileSize < fileSize) {
          var message = 'File is larger than the allowed size of ' + options.maxFileSize + ' MB.';
          errorCallback.call(this, message);
          var status = {
            type : 'error',
            id : options.fileId,
            message : message
          };
          if(self.ws){
            self.ws.send(JSON.stringify(status), function(error) {
              if(error) console.log("WS send error:", error);
            });
          }
        } else {
          _startResize();
        }
      });
    }
    else {
      _startResize();
    }

  });

};

// Upload to S3
Uploader.prototype.upload = function(options, successCallback, errorCallback){

  if(typeof options.fileId === 'undefined') throw new Error('Uploader.upload: "fileId" is not defined.');
  if(typeof options.bucket === 'undefined') throw new Error('Uploader.upload: "bucket" is not defined.');
  if(typeof options.source === 'undefined') throw new Error('Uploader.upload: "source" is not defined.');
  if(typeof options.name === 'undefined') throw new Error('Uploader.upload: "name" is not defined.');
  if(typeof successCallback === 'undefined') throw new Error('Uploader.upload: "successCallback" is not defined.');
  if(typeof errorCallback === 'undefined') throw new Error('Uploader.upload: "errorCallback" is not defined.');

  var self = this;

  var params = {
    localFile: options.source,
    s3Params: {
      ACL : (typeof self.options.aws.acl !== 'undefined') ? self.options.aws.acl : 'public-read',
      Bucket: options.bucket,
      Key: options.name
    }
  };

  var uploader = this.client.uploadFile(params);

  // when there is progress send a message through our websocket connection
  uploader.on('progress', function(){
    var status = {
      type : 'progress',
      id : options.fileId,
      progressAmount : uploader.progressAmount,
      progressTotal : uploader.progressTotal
    };
    if(self.ws){
      self.ws.send(JSON.stringify(status), function(error) {
        if(error) console.log("WS send error:", error);
      });
    }
  });

  // on upload error call error callback
  uploader.on('error', function(err){
    errorCallback.call(uploader, err.stack);
  });

  // when the upload has finished call the success callback and send a message through our websocket
  uploader.on('end', function(obj){
    var status = {
      type : 'result',
      id : options.fileId,
      path : '/' + options.bucket + '/' + options.name
    };
    if(self.ws){
      self.ws.send(JSON.stringify(status), function(error) {
        if(error) console.log("WS send error:", error);
      });
    }
    successCallback.call(uploader, status);
  });

};

// Get image file size and call callback function
var _imageFileSize = function(source, callback){

  if(typeof source === 'undefined') throw new Error('_imageFileSize: "source" is not defined.');
  if(typeof callback === 'undefined') throw new Error('_imageFileSize: "callback" is not defined.');
  gm(source).filesize(function(err, value){
    callback.call(this, err, value);
  });

};

// Get image size and call callback function
// Callback returns width and height properties
var _imageSize = function(source, callback){

  if(typeof source === 'undefined') throw new Error('_imageSize: "source" is not defined.');
  if(typeof callback === 'undefined') throw new Error('_imageSize: "callback" is not defined.');
  gm(source).size(function(err, value){
    callback.call(this, err, value);
  });

};

// Write image to directory
var _writeImage = function(img, options, successCallback, errorCallback){

  img.write(options.destination, function(uploadErr){
    if(!uploadErr) {
      successCallback.call(img, options.destination);
    } else {
      errorCallback.call(img, uploadErr);
      console.log('_writeImage: problem on write.');
    }
  });

};

// Resize image - depends on size and options
var _resize = function(options, size, successCallback, errorCallback){

  var img = gm(options.source);

  var newWidth = options.width;
  var newHeight = options.height;

  // if this needs to be square
  if(options.square && options.width === options.height) {

    // if we have size info
    if(typeof size !== 'undefined') {
      // if the width is more than height we make it null so that
      // we pass the height to be used by gm, so the outcome
      // is an image with a height set to the max
      // and the width is the aspect ratio adjusted... but will be bigger,
      // and then the gm crop method trims off the width overage.
      // the same would occur in vice versa if height is bigger than width.
      if(size.width >= size.height) newWidth = null;
      else newHeight = null;
    }

    img
      .resize(newWidth, newHeight)
      .gravity('Center')
      .crop(options.width, options.height, 0, 0)
      .quality(options.quality);

  } else { // else it doesn't need to be square

    // if we have size info
    if(typeof size !== 'undefined') {
      // if the the image width is larger than height... else height is larger
      if(size.width >= size.height){
        // if new height is less than options.height - we're good and we use options.width
        // as the max value pass to the gm resize function...
        if((size.height / size.width) * options.width <= options.height) newHeight = null;
        // ...else we use options.height as the max value to pass into the gm resize
        else newWidth = null
      } else {
        // same logic as if block... just reversed
        if((size.width / size.height) * options.height <= options.width) newWidth = null;
        else newHeight = null
      }
    }

    img.resize(newWidth, newHeight);

  }

  img
    .quality(options.quality)
    .autoOrient();

  if(options.noProfile) img.noProfile();

  _writeImage(img, options, successCallback, errorCallback);

};

module.exports = Uploader;