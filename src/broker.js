import { Subject } from 'rxjs';

export class Broker {
  /**
   * A simple pub-sub interface.
   * @param {Function} publishFn A function that should publish a message upstream
   * @param {Observable} source An observable that emits events that can be subscribed to
   */
  constructor(publishFn, source) {
    this.pub = new Subject();
    this.pub.subscribe(publishFn);
    this.sub = source;
  }

  publish(message) {
    return this.pub.next(message);
  }

  pipe(...args) {
    return this.sub.pipe(...args);
  }

  subscribe(...args) {
    return this.sub.subscribe(...args);
  }
}
