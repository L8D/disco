module.exports = Observable;

function Observable(subscribe) {
  this.subscribe = subscribe;
}

Observable.fromPromise = function(fn) {
  return new Observable(function(next, handle, finish) {
    fn().then(function(event) {
      next(event);
      finish();
    }, function(err) {
      handle(err);
      finish();
    });

    return function() {};
  });
};

Observable.fromNodeStream = function(fn) {
  return new Observable(function(next, handle, finish) {
    var stream = fn();

    stream.on('readable', onreadable);

    function onreadable() {
      var event;
      while (null !== (event = stream.read())) {
        next(event);
      }
    }

    stream.on('error', handle);
    stream.on('end', finish);

    return function() {
      stream.removeListener('readable', onreadable);
    };
  });
};

Observable.of = function(value) {
  return new Observable(function(next, handle, finish) {
    next(value);
    finish();

    return function() {};
  });
};

Observable.error = function(err) {
  return new Observable(function(next, handle, finish) {
    handle(err);
    finish();

    return function() {};
  });
};

Observable.empty = function() {
  return new Observable(function(next, handle, finish) {
    finish();

    return function() {};
  });
};

var proto = Observable.prototype;

// map (O a) :: (a -> b) -> O b
proto.map = function(fn) {
  var sub = this.subscribe;

  return new Observable(function(next, handle, finish) {
    return sub(function(event) {
      next(fn(event));
    }, handle, finish);
  });
};

// filter (O a) :: (a -> Bool) -> O a
proto.filter = function(fn) {
  var sub = this.subscribe;

  return new Observable(function(next, handle, finish) {
    return sub(function(event) {
      if (fn(event)) next(event);
    }, handle, finish);
  });
};

// mergeAll (O (O b)) :: O b
proto.mergeAll = function() {
  var sub = this.subscribe;

  return new Observable(function(next, handle, finish) {
    var thisFinished = false;
    var unfinished = 0;

    return sub(function(event) {
      unfinished++;

      event.subscribe(next, handle, function() {
        unfinished--;

        if (thisFinished && unfinished === 0) finish();
      });
    }, handle, function() {
      thisFinished = true;
    });
  });
};

// chain (O a) :: (a -> O b) -> O b
proto.chain = function(fn) {
  return this.map(fn).mergeAll();
};

// merge (O a) :: O a -> O a
proto.merge = function(that) {
  var subThis = this.subscribe;
  var subThat = that.subscribe;

  return new Observable(function(next, handle, finish) {
    var thisFinished = false;
    var thatFinished = false;

    var cancelThis = subThis(next, handle, function() {
      thisFinished = true;

      if (thatFinished) finish();
    });

    var cancelThat = subThat(next, handle, function() {
      thatFinished = true;

      if (thisFinished) finish();
    });

    return function() {
      cancelThis();
      cancelThat();
    };
  });
};

// concat (O a) :: O a -> O a
proto.concat = function(that) {
  var subThis = this.subscribe;
  var subThat = that.subscribe;

  // no buffering magic! just perform the request as part of the subscription!
  return new Observable(function(next, handle, finish) {
    var cancel = subThis(next, handle, function() {
      cancel = subThat(next, handle, finish);
    });

    return function() {
      cancel();
    };
  });
};

// concatAll (O (O b)) :: O b
proto.concatAll = function() {
  var sub = this.subscribe;

  // and now for the tricky bit (i.e. don't use until tested)
  return new Observable(function(next, handle, finish) {
    var thisFinished = false;
    var waiting = [];

    return sub(function(event) {
      if (waiting.length === 0) {
        event.subscribe(next, handle, function finish2() {
          // if there are children waiting, then start on the next one
          // if not, and this is finished, then that means we are the
          // last, so call finish

          if (waiting.length !== 0) {
            waiting.shift().subscribe(next, handle, finish2);
          } else if (thisFinished) {
            finish();
          }
        });
      } else {
        waiting.push(event);
      }
    }, handle, function() {
      thisFinished = true;
    });
  });
};

// concatMap (O a) :: (a -> O b) -> O b
proto.concatMap = function(fn) {
  return this.map(fn).concatAll();
};

// zipSwitch (O a) :: O b -> (a -> b -> c) -> O c
proto.zipSwitch = function(that, zipper) {
  var subThis = this.subscribe;
  var subThat = that.subscribe;

  return new Observable(function(next, handle, finish) {
    var thisFinished = false;
    var thatFinished = false;

    var latestThat;
    var thatHasEmitted = false;

    var cancelThat = subThat(function(event) {
      latestThat = event;
      thatHasEmitted = true;
    }, handle, function() {
      thatFinished = true;

      if (thisFinished) finish();
    });

    var cancelThis = subThis(function(event) {
      if (thatHasEmitted) { // better than checking for null
        next(zipper(event, latestThat));
      }
    }, handle, function() {
      thisFinished = true;

      if (thatFinished) finish();
    });

    return function() {
      cancelThis();
      cancelThat();
    };
  });
}

// zip (O a) :: O b -> (a -> b -> c) -> O c
proto.zip = function(that, zipper) {
  var subThis = this.subscribe;
  var subThat = that.subscribe;

  return new Observable(function(next, handle, finish) {
    var thisFinished = false;
    var thatFinished = false;

    var thises = [];
    var thates = [];

    var cancelThis = subThis(function(event) {
      if (thates.length === 0) {
        thises.push(event);
      } else {
        next(zipper(event, thates.shift()));
      }
    }, handle, function() {
      finishedThis = true;

      if (finishedThat) finish();
    });

    var cancelThat = subThat(function(event) {
      if (thises.length === 0) {
        thates.push(event);
      } else {
        next(zipper(event, thises.shift()));
      }
    }, handle, function() {
      finishedThat = true;

      if (finishedThis) finish();
    });

    return function() {
      cancelThis();
      cancelThat();
    }
  });
};

// startWith (O a) :: a -> O a
proto.startWith = function(event) {
  var sub = this.subscribe;

  return new Observable(function(next, handle, finish) {
    next(event);

    return sub(next, handle, finish);
  });
};

proto.error = function(fn) {
  var sub = this.subscribe;

  return new Observable(function(next, handle, finish) {
    sub(next, function(error) {
      next(fn(error));
    }, finish);
  });
};
