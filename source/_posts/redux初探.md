---
title: redux 初探
date: 2018-04-11 11:56:01
tags: [react, redux]
categories: react
---

## redux（[中文官网](http://www.redux.org.cn/docs/react-redux/api.html)）

redux 简单来说就是起到状态管理的功能

优点
* 数据单项流，清晰的数据流向可以加快解决bug
* flux的优秀实践者
* 支持自定义中间件，如redux-saga、redux-thunk等等

<!-- more -->

## 数据单向流

* 用简单的对象和数组来描述应用状态
* 用简单对象来描述应用中的变更
* 用纯函数来描述处理变更的逻辑
* 流程如下图所示：

![流程图](https://raw.githubusercontent.com/fengyua5/blog/master/img/redux.jpg)

## API

1、简单的例子如下：

```
import React, { Component } from 'react';
const counter = (state = { value: 0 }, action) => {
  switch (action.type) {
    case 'INCREMENT':
      return { value: state.value + 1 };
    case 'DECREMENT':
      return { value: state.value - 1 };
    default:
      return state;
  }
}
class Counter extends Component {
  state = counter(undefined, {});
  dispatch(action) {
    this.setState(prevState => counter(prevState, action));
  }
  increment = () => {
    this.dispatch({ type: 'INCREMENT' });
  };
  decrement = () => {
    this.dispatch({ type: 'DECREMENT' });
  };
  render() {
    return (
      <div>
        {this.state.value}
        <button onClick={this.increment}>+</button>
        <button onClick={this.decrement}>-</button>
      </div>
    )
  }
}
```

2、createStore

创建一个 Redux store 来以存放应用中所有的 state，应用中应有且仅有一个 store

实例1：

```
import { createStore } from 'redux'

function todos(state = [], action) {
  switch (action.type) {
    case 'ADD_TODO':
      return state.concat([action.text])
    default:
      return state
  }
}

let store = createStore(todos, ['Use Redux'])
```

接入React

```
ReactDOM.render(
  <Provider store={store}>
    <MyRootComponent />
  </Provider>,
  rootEl
)
```

注意Provider 是react-redux的API

3、combineReducers

作用是把多个reducers合成一个reducer

实例：

```
rootReducer = combineReducers({archives: archivesReducer, resume: resumeReducer})
```

4、applyMiddleware（源码很精练，大家可以研究一下）

扩展中间件

实例：

```
function logger({ getState }) {
  return (next) => (action) => {
    console.log('will dispatch', action)

    // 调用 middleware 链中下一个 middleware 的 dispatch。
    let returnValue = next(action)

    console.log('state after dispatch', getState())

    // 一般会是 action 本身，除非
    // 后面的 middleware 修改了它。
    return returnValue
  }
}

let store = createStore(
  todos,
  [ 'Use Redux' ],
  applyMiddleware(logger)
)

store.dispatch({
  type: 'ADD_TODO',
  text: 'Understand the middleware'
})
```

5、bindActionCreators(actionCreators, dispatch)

包装action,作用可以包装action解除耦合

```
this.props.dispatch(resumeAction(....)) 等于
resumeAction = bindActionCreators（resumeAction， dispatch）
this.props.resumeAction(....)
```

6、compose

函数的柯里化，具体不在介绍

## react-redux

2个api

1、Provider

createStore的api已经介绍过实例

2、connect([mapStateToProps], [mapDispatchToProps], [mergeProps], [options])

```
@connect((state) => {
  return {
    APP: state.APP,
    archives: state.archives,
    loadnotify: state.loadnotify,
    switcher: state.switcher
  };
}, (dispatch) => {
  return {
    updateTotalAction: bindActionCreators(updateTotalAction, dispatch)
  }
})
```
