---
title: 对于react组件的一些心得
date: 2017-08-25 18:05:14
tags: [react, 组件]
categories: react
---

## 1 数据是放在props还是state上边？

如果数据仅作为展示只用或者组件ui展示保存在state上面的时候，应该放在props上面或者存储在组件的this上面

<!-- more -->

场景一：

```
class Input extends React.Component {
  constructor(props) {
	super(props);
	this.state = {
	  value: this.props.defaultValue
	}
  }

  render() {
	let {
	  value
	} = this.state;
	let {
	  onChange
	} = this.props;
	return (
	  <input
		type="text"
		value={value}
		onChange={(e) => {
		  this.setState({
			value: e.target.value
		  })
		  isFunction(onChange) && onChange(e);
		}}
	  />
	)
  }
}
```

上面的代码因为Input组件自身要改变要依赖state

场景二：

```
const NoDate = ({className ="", src="...", content="无数据"}) => {
  return (
    <div className="">
	  <Img src={src}/>
	  <p>{content}</p>
	</div>
  )
};
```

这个无状态组件（stateless component）实际上就不需要在state上保存name或者content，当state上没有值的时候就可以写成无状态组件

## 2 组件的划分

那些应该放在组件里面？那些应该有组件外部传入？公共的部分放在组件内部处理，不公共的部分放在组件外部传入

场景一：

我们假设有这样的需求，一个ui某一部分有微小的变化，其他的都一致，这样的话我们就要传入不公共的部分

```
class Card extends React.Component{
	constructor(props){
	  super(props);
	}
	render(){
	  <div>
		公共部分代码...
		{this.props.children}
	  </div>
	}
}
```

## 3 组件内部成功后的回调

比如说上传组件的回调，一些公共的部分由组件处理，然后调用添加图片动作的回调，删除图片操作的回调等等，还有成功后的回调（不要忘记判断回调函数是否存在），因为我们不确定组件请求接口或者做什么操作后组件外部要做什么，例子如1的场景一的 isFunction(onChange) && onChange(e)这段代码

## 4 对组件输出的数据做处理

对后端接口或者类似ant-design的form的getValueFromEvent类似的函数,比如这样的场景：组件输出的是Array,而你需要的是对象，所以你可传入一个处理的函数，如果props上面有着函数，就执行这个函数，如果没有就返回Array，

场景一：

发送请求成功返回这样的字段{errorMessage:0,results: [...], info: {...}}

A要求组件返回给自己ajax的results字段,B要求返回info字段给他，这个时候我们如果用if判断代码以后就难以维护，所以要让外边自己传函数进来自己处理得到相应的结果，各司其职
