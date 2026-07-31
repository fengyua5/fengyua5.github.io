---
title: react学习注意
date: 2017-02-12 22:50:41
categories:
  - react
---

React起源于 Facebook 的内部项目，已经成为当前最流行的前端框架之一，学习react可能会踩到一些坑，下面是一些注意事项

<!-- more -->

## react周期

### 首次实例化

getDefaultProps
getInitialState
componentWillMount
render
componentDidMount

### 实例化完成后的更新

getInitialState
componentWillMount
render
componentDidMount

### 组件已存在时的状态改变

componentWillReceiveProps
shouldComponentUpdate
componentWillUpdate
render
componentDidUpdate

### 销毁&清理期

componentWillUnmount

### 说明

```
1 getDefaultProps
    作用于组件类，只调用一次，返回对象用于设置默认的props，对于引用值，会在实例中共享。

2.getInitialState
作用于组件的实例，在实例创建时调用一次，用于初始化每个实例的state，此时可以访问this.props。

3.componentWillMount
在完成首次渲染之前调用，此时仍可以修改组件的state。

4.render
    必选的方法，创建虚拟DOM，该方法具有特殊的规则：只能通过this.props和this.state
问数据可以返回null、false或任何React组件只能出现一个顶级组件（不能返回数组）不能
改变组件的状态不能修改DOM的输出

5.componentDidMount
    真实的DOM被渲染出来后调用，在该方法中可通过this.getDOMNode()访问到真实的DOM
元素。此时已可以使用其他类库来操作这个DOM。
在服务端中，该方法不会被调用。

6.componentWillReceiveProps
    组件接收到新的props时调用，并将其作为参数nextProps使用，此时可以更改组件props
及state。
componentWillReceiveProps: function(nextProps) {
    if (nextProps.bool) {
        this.setState({
            bool: true
        });
    }
}

7.shouldComponentUpdate
    组件是否应当渲染新的props或state，返回false表示跳过后续的生命周期方法，通常不需要使用
以避免出现bug。在出现应用的瓶颈时，可通过该方法进行适当的优化。
在首次渲染期间或者调用了forceUpdate方法后，该方法不会被调用

8.componentWillUpdate
    接收到新的props或者state后，进行渲染之前调用，此时不允许更新props或state。

9.componentDidUpdate
    完成渲染新的props或者state后调用，此时可以访问到新的DOM元素。

10.componentWillUnmount
    组件被移除之前被调用，可以用于做一些清理工作，在componentDidMount方法中添加的所有任务
都需要在该方法中撤销，比如创建的定时器或添加的事件监听器。
```

## 一些注意点

1 class改为className,for改为htmlFor,onclick改为onClick，其他的事件类似，大小写敏感，标签必须闭合，
  return出来的必须是一个标签等等
2 bind的问题：ES5中自动绑定this，最后一个参数是event，ES6中必须绑定this，一般的做法是在
  constructor里边绑定
3 props和state的区别：props是父组建传过来的参数，而state是组件自己的状态
4 在循环数组生成dom的时候，一般要设置唯一的key，不然React会有错误警告
5 input等空间的问题，defaultValue一旦设置以后就不能改变，这与我们发起请求之后改变input的
  默认值的需求不符，所以要结合value和onChange事件一些使用
