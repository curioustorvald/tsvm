/*
js-mp3
https://github.com/soundbus-technologies/js-mp3

Copyright (c) 2018 SoundBus Technologies CO., LTD.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/



var Frame = require('A:/tvdos/include/js-mp3/frame.js');
var util = require('A:/tvdos/include/js-mp3/util.js');
var consts = require('A:/tvdos/include/js-mp3/consts.js');
var Frameheader = require('A:/tvdos/include/js-mp3/frameheader.js');

const invalidLength = -1;

var Mp3 = {
    // Create new source object with specified ArrayBuffer
    newSource: function(buf) {

        var source = {
            buf: buf,
            pos: 0
        };

        /**
         * Seek the buffer position
         *
         * @param position
         * @param whence
         */
        source.seek = function (position) {
            if (position < 0 || position > source.buf.byteLength) {
                return {
                    err: "position not correct"
                }
            }
            source.pos = position;
            return {
                pos: source.pos
            };
        };

        source.readFull = function (length) {

            try {
                if (length < 0) throw Error("Source.pos less than 0: "+source.pos)

                var l = Math.min(source.buf.byteLength - source.pos, length);

                if (l < 0) {
                    serial.println("l < 0: "+l)
                    throw Error("l < 0: "+l)
                }

                var bbuf = new Uint8Array(source.buf, source.pos, l);

                source.pos += bbuf.byteLength;

                if (source.pos < 0) {
                    throw Error("pos < 0: "+source.pos)
                }

                return {
                    buf: bbuf,
                    err: null
                };
            } catch (e) {
                return {
                    buf: null,
                    err: e.toString()
                }
            }
        };

        source.getPos = function () {
            if (source.pos > 3) {
                return source.pos - 3; // skip tags
            }
            return source.pos;
        };

        source.skipTags = function () {
            var result = source.readFull(3);
            if (result.err) {
                return {
                    err: result.err
                }
            }
            var buf = result.buf;

            // decode UTF-8
            var t = String.fromCharCode.apply(null, buf);
            switch (t) {
                case "TAG":
                    result = source.readFull(125);
                    if (result.err) {
                        return {
                            err: result.err
                        }
                    }
                    buf = result.buf;
                    break;
                case 'ID3':
                    // Skip version (2 bytes) and flag (1 byte)
                    result = source.readFull(3);
                    if (result.err) {
                        return {
                            err: result.err
                        }
                    }

                    result = source.readFull(4);
                    if (result.err) {
                        return {
                            err: result.err
                        }
                    }
                    buf = result.buf;
                    if (buf.byteLength !== 4) {
                        return {
                            err: "data not enough."
                        };
                    }
                    var size = (((buf[0] >>> 0) << 21) >>> 0) | (((buf[1] >>> 0) << 14) >>> 0) | (((buf[2] >>> 0) << 7) >>> 0) | (buf[3] >>> 0);
                    result = source.readFull(size);
                    if (result.err) {
                        return {
                            err: result.err
                        }
                    }
                    buf = result.buf;
                    break;
                default:
                    source.unread(buf);
//                    source.pos -= 3;
                    break;
            }
            return {};
        };

        source.unread = function (buf) {
            source.pos -= buf.byteLength
        };

        source.rewind = function() {
            source.pos = 0;
        };

        return source;
    },

    newDecoder: function (buf) {
        var s = Mp3.newSource(buf);

        var decoder = {
            source: s,
            sampleRate: 0,
            frame: null,
            frameStarts: [],
//            buf: null,
            pos: 0,
            length: invalidLength
        };

        // ======= Methods of decoder :: start =========
        decoder.readFrame = function () {
            var result = Frame.read(decoder.source, decoder.source.pos, decoder.frame);
            if (result.err) {
                return {
                    err: result.err
                }
            }
            decoder.frame = result.f;
            var pcm_buf = decoder.frame.decode();
//            decoder.buf = util.concatBuffers(decoder.buf, pcm_buf);
            return { buf: pcm_buf };
        };

        decoder.decode = function (callback) {
            var result;
            while(true) {
                result = decoder.readFrame();

                if (typeof callback == "function") callback(result)

                if (result.err) {
                    break;
                }
            }
//            return decoder.buf;
        };

        decoder.ensureFrameStartsAndLength = function () {
            if (decoder.length !== invalidLength) {
                return {}
            }

            var pos = decoder.source.pos;

            decoder.source.rewind();

            var r = decoder.source.skipTags();
            if (r.err) {
                return {
                    err: r.err
                }
            }

            var l = 0;
            while(true) {
                var result = Frameheader.read(decoder.source, decoder.source.pos);
                if (result.err) {
                    if (result.err.toString().indexOf("UnexpectedEOF") > -1) {
                        break;
                    }
                    return {
                        err: result.err
                    };
                }
                decoder.frameStarts.push(result.position);
                l += consts.BytesPerFrame;

                result = decoder.source.readFull(result.h.frameSize() - 4); // move to next frame position
                if (result.err) {
                    break;
                }
            }
            decoder.length = l;

            var result = decoder.source.seek(pos); // reset to beginning position
            if (result.err) {
                return result;
            }

            return {};
        };
        // ======= Methods of decoder :: end =========

        var r = s.skipTags();
        if (r && r.err) {
            throw Error(`Error creating new MP3 source: ${r.err}`)
            return null;
        }

        var result = decoder.readFrame();
        if (result.err) {
            throw Error(`Error reading frame: ${result.err}`)
            return null;
        }

        decoder.sampleRate = decoder.frame.samplingFrequency();

        result = decoder.ensureFrameStartsAndLength();
        if (result.err) {
            throw Error(`Error ensuring Frame starts and length: ${result.err}`)
            return null;
        }

        return decoder;
    }
};

exports = Mp3;
