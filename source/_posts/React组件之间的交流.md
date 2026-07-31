---
title: React组件之间的交流
date: 2017-03-11 10:05:59
categories:
  - react
---

在写react项目的时候，由于我们是基于组件式开发，所以会有一个个的组件，而react的设计思想是单向流，所以组件之间的交流采用什么方式那？

<!-- more -->

## 交流方式

### 组件之间的嵌套

```javascript
// 父组件
var MyContainer = React.createClass({
      getInitialState: function () {
    return {
          checked: false
    };
  },
  onChildChanged: function (newState) {
this.setState({
  checked: newState
});
  },
  render: function() {
var isChecked = this.state.checked ? 'yes' : 'no';
return (
  <div>
    <div>Are you checked: {isChecked}</div>
    <ToggleButton text="Toggle me"
      initialChecked={this.state.checked}
      callbackParent={this.onChildChanged}
      />
  </div>
);
  }
});

// 子组件
var ToggleButton = React.createClass({
  getInitialState: function () {
return {
  checked: this.props.initialChecked
};
  },
  onTextChange: function () {
var newState = !this.state.checked;
this.setState({
  checked: newState
});
// 这里要注意：setState 是一个异步方法，所以需要操作缓存的当前值
this.props.callbackParent(newState);
  },
  render: function () {
// 从【父组件】获取的值
var text = this.props.text;
// 组件自身的状态数据
var checked = this.state.checked;

return (
    <label>{text}: <input type="checkbox"
checked={checked} onChange={this.onTextChange} /></label>
);
  }
});
```

这是一种方法，适用于组件的嵌套层次不深的情况下

### Signal信号机制

通过在body标签上加监听事件，实现组件间的数据交流

1：原生写法

```javascript
function Signal() {
    this.key = Math.random();
    this.event = new window.Event(this.key);
}

Signal.prototype.on = function (fun) {

    document.querySelector("body").addEventListener(this.key,fun,false);
};

Signal.prototype.dispatch = function (params) {
    this.event.params = params;
    document.querySelector("body").dispatchEvent(this.event);
};

var button = new Signal();

button.on(function (event) {
    console.log(event.params)
});

button.dispatch({name:"ss"});
```

2：ES6写法

```javascript
class Signal{
    constructor(){
        this.key = Util.generateUUID();
        this.event = $.Event(this.key);
    }
    listen(listener) {
        $('body').bind(this.key, listener);
    }
    unlisten(listener) {
        $('body').unbind(this.key, listener);
    };
    dispatch(param){
        $('body').trigger(this.event, [param]);
    };
}
module.exports = Signal;
```

我们在componentDidMount函数中绑定，在componentWillUnmount销毁，在接收的地方加监听函数，在出发的地方加dispatch函数和传入传递的参数

### Redux

请参考一下连接

More info: [Redux](http://www.jianshu.com/p/0e42799be566)
