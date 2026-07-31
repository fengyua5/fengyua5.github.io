---
title: react优化
date: 2017-02-15 09:49:12
categories:
  - react
---

### 重复render

React的优点在于在项目的前期我们不必考虑优化性能的问题，当然我们想要把项目的性能优化做到极致，必须知道以下几点

<!-- more -->

假设我们封装了这样的一个组件

```javascript
'use strict';
var React = require("react");
var App = React.createClass({
getInitialState(){
    return {
        list: this.props.dataArr
    }
},

// 对数据的状态进行变更
toggleChecked(event){
    let checked = event.target.checked;
    let index = event.target.getAttribute("data-index");
    let list = this.state.list;
    list[index].checked = checked;

    this.setState({list});
},

render(){
    // 将数组的数据渲染出来
    return (
        <ul>
            {this.state.list.map((data, index)=>{
                return (
                    <ListItem data={data}
                        index={index} key={data.name}
                        toggleChecked={this.toggleChecked}
                    />
                )
            })}
        </ul>
    )
}
});

// 代表每一个子组件
var ListItem = React.createClass({
render(){
    let data = this.props.data;
    let index = this.props.index;

    // checkbox选择框是一个受限组件，用数据来决定它是否选中
    return (
        <li>
            <input type="checkbox" data-index={index} checked={data.checked}
             onChange={this.props.toggleChecked}/>
            <span>{data.name}</span>
        </li>
    )
}
});

// 构造一个2000个数据的数组
let dataArr = [];
for(let i = 0; i < 2000; i++){
let checked = Math.random() < 0.5;
dataArr.push({
    name: i,
    checked
});
}

React.render(<App dataArr={dataArr}/>, document.body);
```

当我们点击一个checkbox的时候，ListItem组件要调用render函数2000次，然而我们只改变了一个checkbox的值，庆幸的react已经给我们提供了解决办法，那就是shouldComponentUpdate(nextProps, nextState)函数，我们只需要判断nextProps和nextState的值是否相等就可以了，如果你运行这个demo后，你会发现react有时还是会卡顿，这是什么原因那？我们再细心的查找一下发现只有数据结构不一样，shouldComponentUpdate生效的一般是不复杂的数据结构，所以这就引出了另外的一个问题，深比较和浅比较？

浅比较：浅比较只是比较引用
深比较：比较值的具体数据结构

```javascript
var obj = {
  count: 1,
  list: [1, 2, 3, 4, 5]
}
var map1 = Immutable.fromJS(obj);
var map2 = map1.set('count', 2);

console.log(Immutable.is(map1.list, map2.list)); // true
```

是的，上面说了那么一大堆，总算该轮到 Immutable 出场了。在进行状态的 Diff 时，对于复杂的 Mutable 数据，一项一项的去遍历不现实，借用 Immutable，可以直接实现「值」的比较，而且性能又好。具体写法如下：

```javascript
shouldComponentUpdate: function(nextProps, nextState) {
  return deepCompare(this, nextProps, nextState);
},

function deepCompare(instance, nextProps, nextState) {
    return !Immutable.is(instance.props, nextProps) ||
        !Immutable.is(instance.state, nextState);
}
```

### 大组件

大组件的创建还是比较花时间的，如果是在chrome还好，在微信浏览器速度大概慢十倍，比如一个长列表，在chrome渲染出来花500ms，在微信浏览器就要5s。
react的快是说在组件创建出来之后变化的时候，通过diff算法来减少dom操作，所以快，但是组件的创建到jsx转化到html，还是需要开销的。
解决办法就是：大列表可以用react-lazyload。
